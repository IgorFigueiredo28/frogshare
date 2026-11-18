// Builds grafana-dashboard.json, the FrogShare dashboard for Grafana (Dashboards > New > Import, or
// monitoring/grafana-sync.js). It reads only the views in monitoring/supabase.sql. Layout, as Grafana's own
// advice has it: the key numbers first, in a strip of equal tiles with their trend; the two main charts
// under them; the rest in sections that open on a click (they also don't query until opened).
// Usage: node monitoring/dashboard.js
const fs = require('fs');
const path = require('path');

const DS = { type: 'grafana-postgresql-datasource', uid: '${DS_FROGSHARE}' };
let nextId = 1;

const sql = (rawSql, format = 'time_series') => [{ refId: 'A', datasource: DS, editorMode: 'code', format, rawQuery: true, rawSql: rawSql.trim().replace(/\s+/g, ' ') }];
const panel = (type, title, gridPos, targets, extra = {}) => ({ id: nextId++, type, title, datasource: DS, gridPos, targets, ...extra });
const steps = (...pairs) => ({ mode: 'absolute', steps: pairs.map(([color, value]) => ({ color, value })) });
const fixed = (name, color) => ({ matcher: { id: 'byName', options: name }, properties: [{ id: 'color', value: { mode: 'fixed', fixedColor: color } }] });
const field = (name, ...properties) => ({ matcher: { id: 'byName', options: name }, properties });
const prop = (id, value) => ({ id, value });

// Filter by app version (dashboard variable); "All" comes as '__all'
const VERSION = `('__all' IN ($versao) OR coalesce(app_version, '?') IN ($versao))`;
const FPS = 'suffix: fps';
const TEXT = { titleSize: 13, valueSize: 30 };

// A tile of the strip: the number of the period (or of now) over its trend line
function tile(title, query, gridPos, { calc = 'mean', unit = 'none', decimals = 0, thresholds, color, description } = {}) {
  return panel('stat', title, gridPos, sql(query), {
    description,
    fieldConfig: {
      defaults: {
        unit, decimals, noValue: '0',
        color: color ? { mode: 'fixed', fixedColor: color } : { mode: 'thresholds' },
        thresholds: thresholds || steps(['blue', null])
      },
      overrides: []
    },
    options: {
      reduceOptions: { calcs: [calc], fields: '', values: false }, colorMode: thresholds ? 'background' : 'value', graphMode: 'area',
      textMode: 'value', justifyMode: 'center', orientation: 'auto', wideLayout: true, showPercentChange: false, text: TEXT
    }
  });
}

function series(title, query, gridPos, { unit = 'none', decimals, stacked = false, bars = false, description, overrides = [], thresholdLine, min = 0 } = {}) {
  const custom = {
    drawStyle: bars ? 'bars' : 'line', lineWidth: bars ? 1 : 2, fillOpacity: bars ? 60 : stacked ? 35 : 12, gradientMode: bars ? 'none' : 'opacity',
    showPoints: 'never', spanNulls: 3600000, lineInterpolation: 'smooth', barAlignment: 0,
    stacking: { mode: stacked ? 'normal' : 'none', group: 'A' }, axisSoftMin: min, axisBorderShow: false, axisCenteredZero: false
  };
  if (thresholdLine) custom.thresholdsStyle = { mode: 'dashed' };
  return panel('timeseries', title, gridPos, sql(query), {
    description,
    fieldConfig: {
      defaults: {
        unit, ...(decimals != null ? { decimals } : {}), custom, color: { mode: 'palette-classic' },
        thresholds: thresholdLine ? steps(['transparent', null], ['red', thresholdLine]) : steps(['green', null])
      },
      overrides
    },
    options: { legend: { displayMode: 'list', placement: 'bottom', showLegend: true }, tooltip: { mode: 'multi', sort: 'desc' } }
  });
}

function bars(title, query, gridPos, xField, { description, overrides = [], stacked = false } = {}) {
  return panel('barchart', title, gridPos, sql(query, 'table'), {
    description,
    fieldConfig: { defaults: { color: { mode: 'palette-classic' }, custom: { fillOpacity: 85, lineWidth: 0, gradientMode: 'none' } }, overrides },
    options: {
      orientation: 'horizontal', xField, showValue: 'auto', stacking: stacked ? 'normal' : 'none', barWidth: 0.7, groupWidth: 0.7,
      legend: { showLegend: stacked, displayMode: 'list', placement: 'bottom' }, tooltip: { mode: 'single', sort: 'none' }, xTickLabelRotation: 0
    }
  });
}

// rows: true when each row of the result is a slice (categories not known in advance); otherwise one row
// whose columns are the slices, which lets each slice keep a fixed colour
function pie(title, query, gridPos, { description, overrides = [], rows = false } = {}) {
  return panel('piechart', title, gridPos, sql(query, 'table'), {
    description,
    fieldConfig: { defaults: { color: { mode: 'palette-classic' }, noValue: 'sem dados' }, overrides },
    options: {
      reduceOptions: { values: rows, calcs: ['lastNotNull'], fields: '' }, pieType: 'donut', displayLabels: ['percent'],
      legend: { displayMode: 'table', placement: 'right', showLegend: true, values: ['value', 'percent'] }, tooltip: { mode: 'single', sort: 'none' }
    }
  });
}

function table(title, query, gridPos, { description, overrides = [] } = {}) {
  return panel('table', title, gridPos, sql(query, 'table'), {
    description,
    fieldConfig: { defaults: { custom: { align: 'auto', cellOptions: { type: 'auto' }, inspect: false }, noValue: '—' }, overrides },
    options: { showHeader: true, cellHeight: 'sm', footer: { show: false, reducer: ['sum'], countRows: false } }
  });
}

const colored = (name, thresholds, unit) => field(name, prop('custom.cellOptions', { type: 'color-background', mode: 'gradient' }), prop('color', { mode: 'thresholds' }), prop('thresholds', thresholds), ...(unit ? [prop('unit', unit)] : []));

// ---------------- Sections ----------------
// Open sections put their panels at the top level; closed ones keep them inside the row until it's opened
const panels = [];
let y = 0;
function section(title, collapsed, build) {
  const row = { id: nextId++, type: 'row', title, collapsed, gridPos: { h: 1, w: 24, x: 0, y }, panels: [] };
  panels.push(row);
  y += 1;
  const inner = [];
  let localY = y;
  const at = (h) => { const top = localY; localY += h; return top; };
  build((p) => inner.push(p), at);
  if (collapsed) { row.panels = inner; }
  else { panels.push(...inner); y = localY; }
}

// ================= Overview (no row: always open) =================
let top = 0;
panels.push(
  tile('Imagem fluida', `
    SELECT $__timeGroupAlias(time, '1h'), 100.0 * avg(CASE WHEN freezes = 0 THEN 1 ELSE 0 END) AS "imagem fluida"
    FROM monitoring.viewer_quality WHERE $__timeFilter(time) GROUP BY 1 ORDER BY 1`, { h: 5, w: 4, x: 0, y: top },
  { unit: 'percent', thresholds: steps(['red', null], ['orange', 70], ['green', 90]), description: 'Parte dos minutos assistidos sem nenhuma travada (média das horas do período).' }),
  tile('FPS de quem assiste', `
    SELECT $__timeGroupAlias(time, '1h'), avg(avg_fps) AS fps
    FROM monitoring.viewer_quality WHERE $__timeFilter(time) AND avg_fps IS NOT NULL GROUP BY 1 ORDER BY 1`, { h: 5, w: 4, x: 4, y: top },
  { unit: FPS, thresholds: steps(['red', null], ['orange', 24], ['green', 45]), description: 'Média das horas do período.' }),
  tile('Erros', `
    SELECT $__timeGroupAlias(time, '1h', 0), count(*) AS erros FROM monitoring.errors WHERE $__timeFilter(time) GROUP BY 1 ORDER BY 1`, { h: 5, w: 4, x: 8, y: top },
  { calc: 'sum', thresholds: steps(['green', null], ['orange', 20], ['red', 100]), description: 'Total do período: do app, da sala e da transmissão pelo navegador.' }),
  tile('Transmissões agora', `
    SELECT $__timeGroupAlias(time, '5m', 0), max(streams) AS "transmissões" FROM monitoring.server_stats WHERE $__timeFilter(time) GROUP BY 1 ORDER BY 1`, { h: 5, w: 4, x: 12, y: top },
  { calc: 'lastNotNull', color: 'purple', description: 'Do retrato que o servidor grava a cada 5 minutos enquanto está acordado.' }),
  tile('Assistindo agora', `
    SELECT $__timeGroupAlias(time, '5m', 0), max(viewers) AS assistindo FROM monitoring.server_stats WHERE $__timeFilter(time) GROUP BY 1 ORDER BY 1`, { h: 5, w: 4, x: 16, y: top },
  { calc: 'lastNotNull', color: 'blue', description: 'Do retrato que o servidor grava a cada 5 minutos enquanto está acordado.' }),
  tile('Cloudflare no mês', `
    SELECT $__timeGroupAlias(time, '1h'), max(cloudflare_gb) AS usado FROM monitoring.server_stats
    WHERE $__timeFilter(time) AND cloudflare_gb IS NOT NULL AND time > date_trunc('month', now()) GROUP BY 1 ORDER BY 1`, { h: 5, w: 4, x: 20, y: top },
  { calc: 'lastNotNull', unit: 'decgbytes', thresholds: steps(['green', null], ['orange', 630], ['red', 810]), description: 'Relay e servidor de mídia somados, como a Cloudflare cobra. O servidor deixa de usar os dois perto de 900 GB.' })
);
top += 5;
panels.push(
  series('Qualidade para quem assiste', `
    SELECT $__timeGroupAlias(time, '1h', NULL), 100.0 * avg(CASE WHEN freezes > 0 THEN 1 ELSE 0 END) AS "minutos com travada", avg(avg_fps) AS "fps médio"
    FROM monitoring.viewer_quality WHERE $__timeFilter(time) GROUP BY 1 ORDER BY 1`, { h: 8, w: 12, x: 0, y: top }, {
    unit: 'percent', decimals: 0, description: 'Por hora: quantos minutos assistidos tiveram alguma travada, e o fps médio.',
    overrides: [fixed('minutos com travada', 'red'), field('fps médio', prop('unit', FPS), prop('custom.axisPlacement', 'right'), prop('color', { mode: 'fixed', fixedColor: 'green' }))]
  }),
  series('Movimento', `
    SELECT t AS time, sum(v) AS "pessoas assistindo", sum(s) AS "transmissões"
    FROM (
      SELECT $__timeGroup(time, '1h') AS t, count(*) / 60.0 AS v, 0 AS s FROM monitoring.viewer_quality WHERE $__timeFilter(time) GROUP BY 1
      UNION ALL SELECT $__timeGroup(time, '1h'), 0, count(*) / 60.0 FROM monitoring.host_quality WHERE $__timeFilter(time) GROUP BY 1
      UNION ALL SELECT $__timeGroup(time, '1h'), 0, count(*) / 60.0 FROM monitoring.web_host_quality WHERE $__timeFilter(time) GROUP BY 1
    ) x GROUP BY 1 ORDER BY 1`, { h: 8, w: 12, x: 12, y: top }, {
    bars: true, decimals: 1, description: 'Por hora, quantas pessoas assistiam e quantas transmissões havia ao mesmo tempo, em média.',
    overrides: [fixed('pessoas assistindo', 'blue'), field('transmissões', prop('custom.drawStyle', 'line'), prop('custom.lineWidth', 2), prop('custom.fillOpacity', 0), prop('color', { mode: 'fixed', fixedColor: 'purple' }))]
  })
);
top += 8;
panels.push(
  bars('Por que travou (minutos)', `
    SELECT diagnosis AS motivo,
      count(*) FILTER (WHERE diagnosis LIKE '%quem transmite%') AS "lado de quem transmite",
      count(*) FILTER (WHERE diagnosis LIKE '%quem assiste%') AS "lado de quem assiste"
    FROM monitoring.viewer_quality WHERE $__timeFilter(time) AND diagnosis <> 'sem problema'
    GROUP BY 1 ORDER BY count(*) DESC`, { h: 8, w: 9, x: 0, y: top }, 'motivo', {
    stacked: true, description: 'O diagnóstico que a página da sala faz em cada minuto com travada.',
    overrides: [fixed('lado de quem transmite', 'orange'), fixed('lado de quem assiste', 'purple')]
  }),
  pie('Como a imagem chega', `
    SELECT count(*) FILTER (WHERE NOT via_sfu AND NOT via_relay) AS "direto", count(*) FILTER (WHERE via_relay AND NOT via_sfu) AS "relay (TURN)",
      count(*) FILTER (WHERE via_sfu) AS "servidor de mídia"
    FROM monitoring.viewer_quality WHERE $__timeFilter(time)`, { h: 8, w: 7, x: 9, y: top }, {
    description: 'Direto não custa nada. Relay e servidor de mídia passam pela Cloudflare e contam no limite do mês.',
    overrides: [fixed('direto', 'green'), fixed('relay (TURN)', 'yellow'), fixed('servidor de mídia', 'blue')]
  }),
  panel('bargauge', 'Limites do plano grátis', { h: 8, w: 8, x: 16, y: top }, sql(`
    WITH last AS (SELECT cloudflare_gb FROM monitoring.server_stats
                  WHERE cloudflare_gb IS NOT NULL AND time > date_trunc('month', now()) ORDER BY time DESC LIMIT 1),
         k AS (SELECT greatest(extract(epoch FROM now() - date_trunc('month', now())) / 86400.0, 1) AS passed,
                      extract(day FROM date_trunc('month', now()) + interval '1 month - 1 day') AS total)
    SELECT (SELECT round(cloudflare_gb, 0) FROM last) AS "Cloudflare: usado no mês",
           (SELECT round(cloudflare_gb / passed * total, 0) FROM last, k) AS "Cloudflare: no fim do mês, neste ritmo",
           round(pg_database_size(current_database()) / 1048576.0, 0) AS "Banco do Supabase"`, 'table'), {
    description: 'Cloudflare: o servidor para de usar relay e servidor de mídia em 900 GB por mês (ela cobra acima de 1.000). Supabase: 500 MB no plano grátis; cheio, o banco pode ficar só para leitura (a limpeza opcional de monitoring/supabase.sql resolve).',
    fieldConfig: {
      defaults: { unit: 'decgbytes', decimals: 0, min: 0, max: 900, color: { mode: 'thresholds' }, thresholds: steps(['green', null], ['orange', 630], ['red', 810]) },
      overrides: [field('Banco do Supabase', prop('unit', 'decmbytes'), prop('max', 500), prop('thresholds', steps(['green', null], ['orange', 400], ['red', 450])))]
    },
    options: { reduceOptions: { calcs: ['lastNotNull'], fields: '', values: false }, displayMode: 'gradient', orientation: 'horizontal', showUnfilled: true, valueMode: 'color', namePlacement: 'top', sizing: 'auto', minVizHeight: 16, maxVizHeight: 32 }
  })
);
top += 8;
y = top;

// ================= Quem assiste (detalhes) =================
section('Quem assiste: detalhes', true, (add, at) => {
  let r = at(8);
  add(series('Travadas', `
    SELECT $__timeGroupAlias(time, '15m', NULL), avg(freezes) AS "travadas por minuto", avg(frozen_s) AS "segundos parados por minuto"
    FROM monitoring.viewer_quality WHERE $__timeFilter(time) GROUP BY 1 ORDER BY 1`, { h: 8, w: 12, x: 0, y: r }, {
    decimals: 1, description: 'Média por pessoa, de minuto em minuto.',
    overrides: [fixed('travadas por minuto', 'orange'), fixed('segundos parados por minuto', 'red')]
  }));
  add(series('FPS: média e os piores', `
    SELECT $__timeGroupAlias(time, '15m', NULL), avg(avg_fps) AS "média", percentile_cont(0.1) WITHIN GROUP (ORDER BY avg_fps::float8) AS "pior 10%"
    FROM monitoring.viewer_quality WHERE $__timeFilter(time) AND avg_fps IS NOT NULL GROUP BY 1 ORDER BY 1`, { h: 8, w: 12, x: 12, y: r }, {
    unit: FPS, decimals: 0, description: 'Os 10% piores minutos mostram quem está sofrendo, mesmo quando a média vai bem.',
    overrides: [fixed('média', 'green'), fixed('pior 10%', 'red')]
  }));
  r = at(8);
  add(series('Atraso e perda', `
    SELECT $__timeGroupAlias(time, '15m', NULL), avg(rtt_ms / 2.0 + buffer_ms) AS "atraso até a tela", avg(loss_pct) AS "perda de pacotes"
    FROM monitoring.viewer_quality WHERE $__timeFilter(time) GROUP BY 1 ORDER BY 1`, { h: 8, w: 8, x: 0, y: r }, {
    unit: 'ms', decimals: 0, description: 'Atraso: metade do ida e volta da rede mais o buffer de quem assiste. Perda acima de 2% já trava.',
    overrides: [fixed('atraso até a tela', 'blue'), field('perda de pacotes', prop('unit', 'percent'), prop('custom.axisPlacement', 'right'), prop('decimals', 1), prop('color', { mode: 'fixed', fixedColor: 'red' }))]
  }));
  add(pie('Resolução que chega', `
    SELECT count(*) FILTER (WHERE h >= 1000) AS "1080p ou mais", count(*) FILTER (WHERE h >= 700 AND h < 1000) AS "720p",
      count(*) FILTER (WHERE h >= 500 AND h < 700) AS "540p", count(*) FILTER (WHERE h < 500) AS "menor"
    FROM (SELECT monitoring.num(split_part(resolution, 'x', 2)) AS h FROM monitoring.viewer_quality WHERE $__timeFilter(time)) r`, { h: 8, w: 8, x: 8, y: r }, {
    description: 'Altura da imagem que chega. Ultrawide em 1080p chega com menos de 1080 de altura.',
    overrides: [fixed('1080p ou mais', 'green'), fixed('720p', 'blue'), fixed('540p', 'orange'), fixed('menor', 'red')]
  }));
  add(pie('Navegadores', `
    SELECT browser || ' (' || platform || ')' AS navegador, count(*) AS minutos
    FROM monitoring.viewer_quality WHERE $__timeFilter(time) GROUP BY 1 ORDER BY 2 DESC LIMIT 8`, { h: 8, w: 8, x: 16, y: r }, { rows: true }));
});

// ================= Quem transmite (detalhes) =================
section('Quem transmite: detalhes', true, (add, at) => {
  let r = at(8);
  add(bars('Versões em uso (minutos transmitidos)', `
    SELECT versao, minutos FROM (
      SELECT coalesce(app_version, '?') AS versao, count(*) AS minutos FROM monitoring.host_quality WHERE $__timeFilter(time) GROUP BY 1
      UNION ALL
      SELECT 'navegador' AS versao, count(*) AS minutos FROM monitoring.web_host_quality WHERE $__timeFilter(time)
    ) v WHERE minutos > 0 ORDER BY minutos DESC`, { h: 8, w: 8, x: 0, y: r }, 'versao', {
    description: 'Mostra se a atualização automática chegou em todo mundo.', overrides: [fixed('minutos', 'purple')]
  }));
  add(series('Codificação: placa de vídeo × processador', `
    SELECT $__timeGroupAlias(time, '15m', NULL), sum(links_gpu) / 15.0 AS "placa de vídeo", sum(links_cpu) / 15.0 AS "processador"
    FROM monitoring.host_quality WHERE $__timeFilter(time) AND ${VERSION} GROUP BY 1 ORDER BY 1`, { h: 8, w: 8, x: 8, y: r }, {
    stacked: true, decimals: 1, description: 'Cópias da imagem sendo codificadas ao mesmo tempo, em média. Pelo processador pesa no jogo.',
    overrides: [fixed('placa de vídeo', 'green'), fixed('processador', 'red')]
  }));
  add(series('FPS de quem transmite', `
    SELECT $__timeGroupAlias(time, '15m', NULL), avg(capture_fps) AS "captura", avg(pipeline_fps) AS "depois do redesenho", avg(sent_fps) AS "enviado"
    FROM monitoring.host_quality WHERE $__timeFilter(time) AND ${VERSION} GROUP BY 1 ORDER BY 1`, { h: 8, w: 8, x: 16, y: r }, {
    unit: FPS, decimals: 0, description: 'Captura baixa: tela parada ou jogo travando. Enviado bem abaixo do redesenho: o codificador não deu conta.',
    overrides: [fixed('captura', 'blue'), fixed('depois do redesenho', 'purple'), fixed('enviado', 'green')]
  }));
  r = at(8);
  add(series('Aperto no PC', `
    SELECT $__timeGroupAlias(time, '15m', NULL), 100.0 * avg(CASE WHEN auto_fps THEN 1 ELSE 0 END) AS "em 30 fps automático",
      100.0 * avg(CASE WHEN cpu_limited THEN 1 ELSE 0 END) AS "limitado pelo processador",
      100.0 * avg(CASE WHEN bandwidth_limited THEN 1 ELSE 0 END) AS "limitado pela internet"
    FROM monitoring.host_quality WHERE $__timeFilter(time) AND ${VERSION} GROUP BY 1 ORDER BY 1`, { h: 8, w: 8, x: 0, y: r }, {
    unit: 'percent', decimals: 0, description: 'Parte dos minutos transmitidos em cada situação.',
    overrides: [fixed('em 30 fps automático', 'yellow'), fixed('limitado pelo processador', 'red'), fixed('limitado pela internet', 'orange')]
  }));
  add(series('Upload', `
    SELECT $__timeGroupAlias(time, '15m', NULL), avg(upload_kbps) * 1000 AS "média por transmissão", max(upload_kbps) * 1000 AS "maior"
    FROM monitoring.host_quality WHERE $__timeFilter(time) AND ${VERSION} GROUP BY 1 ORDER BY 1`, { h: 8, w: 8, x: 8, y: r }, {
    unit: 'bps', decimals: 1, description: 'Somando as cópias que cada transmissão manda (uma por pessoa, ou uma só pelo servidor de mídia).',
    overrides: [fixed('média por transmissão', 'blue'), fixed('maior', 'purple')]
  }));
  add(series('Redesenho e codificação por quadro', `
    SELECT $__timeGroupAlias(time, '15m', NULL), avg(draw_ms) AS "redesenho", avg(encode_ms) AS "codificação"
    FROM monitoring.host_quality WHERE $__timeFilter(time) AND ${VERSION} GROUP BY 1 ORDER BY 1`, { h: 8, w: 8, x: 16, y: r }, {
    unit: 'ms', decimals: 1, description: 'A 60 fps cada quadro tem 16 ms ao todo.',
    overrides: [fixed('redesenho', 'purple'), fixed('codificação', 'orange')]
  }));
  r = at(8);
  add(table('Placas de vídeo', `
    SELECT coalesce(gpu_model, '?') AS placa, count(*) AS minutos,
      round(100.0 * sum(links_cpu) / nullif(sum(links), 0), 0) AS "% no processador",
      round(avg(sent_fps), 0) AS "fps enviado", round(100.0 * avg(CASE WHEN auto_fps THEN 1 ELSE 0 END), 0) AS "% em 30 automático",
      round(avg(encode_ms), 1) AS "codificação (ms)"
    FROM monitoring.host_quality WHERE $__timeFilter(time) AND ${VERSION} GROUP BY 1 ORDER BY 2 DESC LIMIT 15`, { h: 8, w: 12, x: 0, y: r }, {
    description: 'Placas que codificam no processador ou vivem em 30 fps automático são as que mais sofrem.',
    overrides: [
      colored('% no processador', steps(['green', null], ['orange', 10], ['red', 40]), 'percent'),
      colored('% em 30 automático', steps(['green', null], ['orange', 20], ['red', 50]), 'percent'),
      colored('fps enviado', steps(['red', null], ['orange', 30], ['green', 50]))
    ]
  }));
  add(pie('Captura de tela', `
    SELECT count(*) FILTER (WHERE capture = 'wgc') AS "rápida (WGC)", count(*) FILTER (WHERE capture = 'dxgi') AS "antiga (DXGI)",
      count(*) FILTER (WHERE capture IS NULL OR capture NOT IN ('wgc', 'dxgi')) AS "outra (Mac, versões antigas)"
    FROM monitoring.host_quality WHERE $__timeFilter(time) AND ${VERSION}`, { h: 8, w: 6, x: 12, y: r }, {
    description: 'A captura antiga (DXGI) fica em ~32 fps e pesa mais no jogo.',
    overrides: [fixed('rápida (WGC)', 'green'), fixed('antiga (DXGI)', 'red'), fixed('outra (Mac, versões antigas)', 'blue')]
  }));
  add(pie('Sistema', `
    SELECT count(*) FILTER (WHERE platform = 'Windows') AS "Windows", count(*) FILTER (WHERE platform = 'Mac') AS "Mac",
      count(*) FILTER (WHERE platform NOT IN ('Windows', 'Mac')) AS "outro"
    FROM monitoring.host_quality WHERE $__timeFilter(time) AND ${VERSION}`, { h: 8, w: 6, x: 18, y: r }, {
    overrides: [fixed('Windows', 'blue'), fixed('Mac', 'purple'), fixed('outro', 'yellow')]
  }));
  r = at(6);
  add(table('Pelo navegador', `
    SELECT browser || ' (' || platform || ')' AS navegador, count(*) AS minutos, round(avg(sent_fps), 0) AS "fps enviado",
      round(100.0 * avg(CASE WHEN auto_fps THEN 1 ELSE 0 END), 0) AS "% em 30 automático",
      round(100.0 * avg(CASE WHEN piped THEN 1 ELSE 0 END), 0) AS "% pela placa de vídeo",
      round(100.0 * avg(CASE WHEN mode = 'sfu' THEN 1 ELSE 0 END), 0) AS "% no servidor de mídia",
      round(avg(upload_kbps) / 1000.0, 1) AS "upload (Mbps)"
    FROM monitoring.web_host_quality WHERE $__timeFilter(time) GROUP BY 1 ORDER BY 2 DESC`, { h: 6, w: 24, x: 0, y: r }, {
    description: 'Transmissões feitas em transmitir.html, por navegador.',
    overrides: [colored('% pela placa de vídeo', steps(['red', null], ['orange', 50], ['green', 90]), 'percent'), colored('fps enviado', steps(['red', null], ['orange', 30], ['green', 50]))]
  }));
});

// ================= Erros =================
section('Erros', true, (add, at) => {
  let r = at(7);
  add(series('Erros por hora', `
    SELECT $__timeGroupAlias(time, '1h', 0), origin AS metric, count(*) AS value FROM monitoring.errors
    WHERE $__timeFilter(time) GROUP BY 1, 2 ORDER BY 1`, { h: 7, w: 24, x: 0, y: r }, {
    stacked: true, bars: true, decimals: 0,
    overrides: [fixed('sala', 'blue'), fixed('app (tela)', 'purple'), fixed('app (processo)', 'orange'), fixed('transmitir pelo navegador', 'yellow')]
  }));
  r = at(10);
  add(table('Mais comuns', `
    SELECT message AS erro, origin AS onde, string_agg(DISTINCT coalesce(app_version, '?'), ', ') AS "versões", count(*) AS vezes, max(time) AS "último"
    FROM monitoring.errors WHERE $__timeFilter(time) GROUP BY 1, 2 ORDER BY 4 DESC LIMIT 30`, { h: 10, w: 14, x: 0, y: r }, {
    description: 'Números e códigos viram N e # para erros iguais se juntarem.',
    overrides: [field('último', prop('unit', 'dateTimeFromNow')), colored('vezes', steps(['green', null], ['orange', 5], ['red', 20])), field('erro', prop('custom.width', 420))]
  }));
  add(table('Novos', `
    SELECT e.message AS erro, e.origin AS onde, count(*) AS vezes, min(e.time) AS "primeira vez"
    FROM monitoring.errors e
    WHERE $__timeFilter(e.time) AND NOT EXISTS (
      SELECT 1 FROM monitoring.errors o WHERE o.message = e.message AND o.time < $__timeFrom()::timestamptz AND o.time > $__timeFrom()::timestamptz - interval '30 days')
    GROUP BY 1, 2 ORDER BY 3 DESC LIMIT 30`, { h: 10, w: 10, x: 14, y: r }, {
    description: 'Erros do período que não apareceram nos 30 dias antes dele: o que uma versão nova trouxe.',
    overrides: [field('primeira vez', prop('unit', 'dateTimeFromNow')), colored('vezes', steps(['orange', null], ['red', 10]))]
  }));
});

// ================= Servidor e Cloudflare =================
section('Servidor e Cloudflare', true, (add, at) => {
  let r = at(8);
  add(series('Ao vivo ao longo do tempo', `
    SELECT $__timeGroupAlias(time, '5m', NULL), max(streams) AS "transmissões", max(viewers) AS "assistindo", max(sfu_streams) AS "pelo servidor de mídia"
    FROM monitoring.server_stats WHERE $__timeFilter(time) GROUP BY 1 ORDER BY 1`, { h: 8, w: 12, x: 0, y: r }, {
    decimals: 0, description: 'Retratos do servidor a cada 5 minutos enquanto está acordado.',
    overrides: [fixed('assistindo', 'blue'), fixed('transmissões', 'purple'), fixed('pelo servidor de mídia', 'green')]
  }));
  add(series('Cloudflare no mês', `
    SELECT $__timeGroupAlias(time, '1h', NULL), max(cloudflare_gb) AS "total", max(cloudflare_sfu_gb) AS "servidor de mídia", max(cloudflare_relay_gb) AS "relay (TURN)"
    FROM monitoring.server_stats WHERE $__timeFilter(time) AND cloudflare_gb IS NOT NULL GROUP BY 1 ORDER BY 1`, { h: 8, w: 12, x: 12, y: r }, {
    unit: 'decgbytes', decimals: 1, thresholdLine: 900, description: 'Acumulado do mês. A linha tracejada é o limite do servidor (900 GB).',
    overrides: [fixed('total', 'purple'), fixed('servidor de mídia', 'blue'), fixed('relay (TURN)', 'yellow')]
  }));
});

const dashboard = {
  __inputs: [{ name: 'DS_FROGSHARE', label: 'FrogShare (Supabase)', description: 'O PostgreSQL do Supabase, com o login grafana_reader', type: 'datasource', pluginId: 'grafana-postgresql-datasource', pluginName: 'PostgreSQL' }],
  __requires: [
    { type: 'datasource', id: 'grafana-postgresql-datasource', name: 'PostgreSQL', version: '1.0.0' },
    { type: 'grafana', id: 'grafana', name: 'Grafana', version: '10.4.0' }
  ],
  title: 'FrogShare',
  uid: 'frogshare',
  description: 'Quem transmite, quem assiste, erros e Cloudflare. Só números, sem ids de sala nem de pessoas.',
  tags: ['frogshare'],
  timezone: 'browser',
  editable: true,
  graphTooltip: 1,
  liveNow: false,
  refresh: '5m',
  time: { from: 'now-24h', to: 'now' },
  timepicker: { refresh_intervals: ['1m', '5m', '15m', '1h'] },
  schemaVersion: 39,
  version: 3,
  links: [{ title: 'Como funciona', type: 'link', url: 'https://github.com/IgorFigueiredo28/frogshare/tree/main/monitoring', targetBlank: true, icon: 'doc', tooltip: 'monitoring/README.md' }],
  templating: {
    list: [{
      name: 'versao', label: 'Versão do app', type: 'query', datasource: DS,
      definition: "SELECT DISTINCT coalesce(app_version, '?') FROM monitoring.host_quality WHERE time > now() - interval '30 days' ORDER BY 1 DESC",
      query: "SELECT DISTINCT coalesce(app_version, '?') FROM monitoring.host_quality WHERE time > now() - interval '30 days' ORDER BY 1 DESC",
      refresh: 2, multi: true, includeAll: true, allValue: "'__all'", sort: 0, hide: 0, regex: '', skipUrlSync: false,
      current: { selected: true, text: ['All'], value: ['$__all'] }, options: []
    }]
  },
  annotations: {
    list: [
      { builtIn: 1, datasource: { type: 'grafana', uid: '-- Grafana --' }, enable: true, hide: true, iconColor: 'rgba(0, 211, 255, 1)', name: 'Annotations & Alerts', type: 'dashboard' },
      {
        name: 'Versões novas', enable: true, iconColor: 'purple', datasource: DS,
        target: {
          refId: 'Anno', datasource: DS, editorMode: 'code', format: 'table', rawQuery: true,
          rawSql: "SELECT min(time) AS time, 'FrogShare ' || app_version || ': primeira transmissão nesta versão' AS text, 'versão' AS tags FROM monitoring.host_quality WHERE app_version IS NOT NULL GROUP BY app_version HAVING min(time) BETWEEN $__timeFrom()::timestamptz AND $__timeTo()::timestamptz"
        }
      }
    ]
  },
  panels
};

const out = path.join(__dirname, 'grafana-dashboard.json');
fs.writeFileSync(out, JSON.stringify(dashboard, null, 2) + '\n');
console.log(`${panels.length} painéis no topo (${panels.reduce((n, p) => n + (p.panels?.length || 0), 0)} dentro de seções fechadas) -> ${out}`);
