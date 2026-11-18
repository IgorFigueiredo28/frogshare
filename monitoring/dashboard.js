// Builds grafana-dashboard.json, the FrogShare dashboard for Grafana (import it in Dashboards > New > Import).
// It reads only the views in monitoring/supabase.sql. Usage: node monitoring/dashboard.js
const fs = require('fs');
const path = require('path');

const DS = { type: 'grafana-postgresql-datasource', uid: '${DS_FROGSHARE}' };
let nextId = 1;
let y = 0;

const sql = (rawSql, format = 'time_series') => [{ refId: 'A', datasource: DS, editorMode: 'code', format, rawQuery: true, rawSql: rawSql.trim().replace(/\s+/g, ' ') }];
const base = (type, title, gridPos, targets, extra = {}) => ({ id: nextId++, type, title, datasource: DS, gridPos, targets, ...extra });

function row(title) {
  const p = { id: nextId++, type: 'row', title, collapsed: false, gridPos: { h: 1, w: 24, x: 0, y }, panels: [] };
  y += 1;
  return p;
}

function stat(title, query, x, w, { unit = 'none', decimals = 0, color = 'green', description } = {}) {
  return base('stat', title, { h: 4, w, x, y }, sql(query, 'table'), {
    description,
    fieldConfig: { defaults: { unit, decimals, color: { mode: 'thresholds' }, thresholds: { mode: 'absolute', steps: [{ color, value: null }] } }, overrides: [] },
    options: { reduceOptions: { calcs: ['lastNotNull'], fields: '', values: false }, colorMode: 'value', graphMode: 'none', textMode: 'value', justifyMode: 'center', orientation: 'auto' }
  });
}

function series(title, query, gridPos, { unit = 'none', decimals, stacked = false, description, overrides = [], thresholdLine } = {}) {
  const custom = {
    drawStyle: 'line', lineWidth: 2, fillOpacity: stacked ? 35 : 8, showPoints: 'never', spanNulls: 3600000,
    stacking: { mode: stacked ? 'normal' : 'none', group: 'A' }, axisSoftMin: 0
  };
  if (thresholdLine) custom.thresholdsStyle = { mode: 'line' };
  return base('timeseries', title, gridPos, sql(query), {
    description,
    fieldConfig: {
      defaults: {
        unit, ...(decimals != null ? { decimals } : {}), custom, color: { mode: 'palette-classic' },
        thresholds: { mode: 'absolute', steps: [{ color: 'transparent', value: null }, ...(thresholdLine ? [{ color: 'red', value: thresholdLine }] : [])] }
      },
      overrides
    },
    options: { legend: { displayMode: 'list', placement: 'bottom', showLegend: true }, tooltip: { mode: 'multi', sort: 'none' } }
  });
}

function bars(title, query, gridPos, xField, { description } = {}) {
  return base('barchart', title, gridPos, sql(query, 'table'), {
    description,
    fieldConfig: { defaults: { color: { mode: 'palette-classic' }, custom: { fillOpacity: 80, lineWidth: 0 } }, overrides: [] },
    options: { orientation: 'horizontal', xField, showValue: 'auto', barWidth: 0.7, groupWidth: 0.7, legend: { showLegend: false, displayMode: 'list', placement: 'bottom' }, tooltip: { mode: 'single', sort: 'none' } }
  });
}

function pie(title, query, gridPos, { description } = {}) {
  return base('piechart', title, gridPos, sql(query, 'table'), {
    description,
    fieldConfig: { defaults: { color: { mode: 'palette-classic' } }, overrides: [] },
    options: {
      reduceOptions: { values: true, calcs: ['lastNotNull'], fields: '' }, pieType: 'donut', displayLabels: [],
      legend: { displayMode: 'table', placement: 'right', showLegend: true, values: ['value', 'percent'] }, tooltip: { mode: 'single', sort: 'none' }
    }
  });
}

function table(title, query, gridPos, { description, overrides = [] } = {}) {
  return base('table', title, gridPos, sql(query, 'table'), {
    description,
    fieldConfig: { defaults: { custom: { align: 'auto', cellOptions: { type: 'auto' } } }, overrides },
    options: { showHeader: true, cellHeight: 'sm', footer: { show: false, reducer: ['sum'], countRows: false } }
  });
}

const percentRight = (name) => ({ matcher: { id: 'byName', options: name }, properties: [{ id: 'unit', value: 'percent' }, { id: 'custom.axisPlacement', value: 'right' }, { id: 'max', value: 100 }] });
const nowValue = (column) => `SELECT coalesce((SELECT ${column} FROM monitoring.server_stats WHERE time > now() - interval '12 minutes' ORDER BY time DESC LIMIT 1), 0) AS valor`;

const panels = [];
const add = (...ps) => ps.forEach(p => panels.push(p));

// ---------------- Agora ----------------
add(row('Agora'));
add(
  stat('Transmissões ao vivo', nowValue('streams'), 0, 4, { description: 'Do retrato que o servidor grava a cada 5 minutos enquanto está acordado.' }),
  stat('Pessoas assistindo', nowValue('viewers'), 4, 4),
  stat('Salas ao vivo', nowValue('rooms_live'), 8, 4),
  stat('Pelo servidor de mídia', nowValue('sfu_streams'), 12, 4, { color: 'blue', description: 'Transmissões que mandam uma cópia só para a Cloudflare repassar (3 ou mais assistindo).' }),
  base('gauge', 'Cloudflare no mês', { h: 4, w: 4, x: 16, y }, sql(`
    SELECT cloudflare_gb AS usado FROM monitoring.server_stats
    WHERE cloudflare_gb IS NOT NULL AND time > date_trunc('month', now()) ORDER BY time DESC LIMIT 1`, 'table'), {
    description: 'Relay e servidor de mídia somados, como a Cloudflare cobra. O servidor para de usar os dois perto de 900 GB.',
    fieldConfig: { defaults: { unit: 'decgbytes', decimals: 0, min: 0, max: 900, color: { mode: 'thresholds' }, thresholds: { mode: 'absolute', steps: [{ color: 'green', value: null }, { color: 'orange', value: 630 }, { color: 'red', value: 810 }] } }, overrides: [] },
    options: { reduceOptions: { calcs: ['lastNotNull'], fields: '', values: false }, showThresholdMarkers: true, showThresholdLabels: false }
  }),
  stat('Projeção do mês', `
    SELECT round(cloudflare_gb / greatest(extract(epoch FROM now() - date_trunc('month', now())) / 86400.0, 1)
      * extract(day FROM date_trunc('month', now()) + interval '1 month - 1 day'), 0) AS valor
    FROM monitoring.server_stats WHERE cloudflare_gb IS NOT NULL AND time > date_trunc('month', now()) ORDER BY time DESC LIMIT 1`, 20, 4,
  { unit: 'decgbytes', color: 'purple', description: 'No ritmo do mês até agora.' })
);
y += 4;
add(series('Ao vivo ao longo do tempo', `
  SELECT $__timeGroupAlias(time, '5m', NULL), max(streams) AS "transmissões", max(viewers) AS "assistindo", max(sfu_streams) AS "pelo servidor de mídia"
  FROM monitoring.server_stats WHERE $__timeFilter(time) GROUP BY 1 ORDER BY 1`, { h: 7, w: 24, x: 0, y }, { decimals: 0 }));
y += 7;

// ---------------- Quem assiste ----------------
add(row('Quem assiste'));
add(series('Travadas', `
  SELECT $__timeGroupAlias(time, '15m', NULL), avg(freezes) AS "travadas por minuto", avg(frozen_s) AS "segundos parados por minuto",
    100.0 * avg(CASE WHEN freezes > 0 THEN 1 ELSE 0 END) AS "% dos minutos com travada"
  FROM monitoring.viewer_quality WHERE $__timeFilter(time) GROUP BY 1 ORDER BY 1`, { h: 8, w: 12, x: 0, y },
{ decimals: 1, overrides: [percentRight('% dos minutos com travada')], description: 'Média por pessoa, de minuto em minuto, como a página da sala mede.' }));
add(series('FPS de quem assiste', `
  SELECT $__timeGroupAlias(time, '15m', NULL), avg(avg_fps) AS "média", percentile_cont(0.1) WITHIN GROUP (ORDER BY avg_fps::float8) AS "pior 10%"
  FROM monitoring.viewer_quality WHERE $__timeFilter(time) AND avg_fps IS NOT NULL GROUP BY 1 ORDER BY 1`, { h: 8, w: 12, x: 12, y }, { decimals: 0 }));
y += 8;
add(bars('Por que travou (minutos)', `
  SELECT diagnosis AS motivo, count(*) AS minutos FROM monitoring.viewer_quality
  WHERE $__timeFilter(time) AND diagnosis <> 'sem problema' GROUP BY 1 ORDER BY 2 DESC`, { h: 8, w: 10, x: 0, y }, 'motivo',
{ description: 'O diagnóstico que a própria página da sala faz: lado de quem transmite ou de quem assiste.' }));
add(pie('Como a imagem chega', `
  SELECT CASE WHEN via_sfu THEN 'servidor de mídia' WHEN via_relay THEN 'relay (TURN)' ELSE 'direto' END AS caminho, count(*) AS minutos
  FROM monitoring.viewer_quality WHERE $__timeFilter(time) GROUP BY 1 ORDER BY 2 DESC`, { h: 8, w: 7, x: 10, y }));
add(pie('Navegadores de quem assiste', `
  SELECT browser || ' (' || platform || ')' AS navegador, count(*) AS minutos
  FROM monitoring.viewer_quality WHERE $__timeFilter(time) GROUP BY 1 ORDER BY 2 DESC LIMIT 8`, { h: 8, w: 7, x: 17, y }));
y += 8;

// ---------------- Quem transmite ----------------
add(row('Quem transmite'));
add(bars('Versões em uso (minutos transmitidos)', `
  SELECT coalesce(app_version, '?') AS versao, count(*) AS minutos FROM monitoring.host_quality WHERE $__timeFilter(time) GROUP BY 1
  UNION ALL SELECT 'navegador', count(*) FROM monitoring.web_host_quality WHERE $__timeFilter(time) HAVING count(*) > 0
  ORDER BY 2 DESC`, { h: 8, w: 8, x: 0, y }, 'versao', { description: 'Mostra se a atualização automática chegou em todo mundo.' }));
add(series('Codificação: placa de vídeo × processador', `
  SELECT $__timeGroupAlias(time, '15m', NULL), sum(links_gpu) / 15.0 AS "placa de vídeo", sum(links_cpu) / 15.0 AS "processador"
  FROM monitoring.host_quality WHERE $__timeFilter(time) GROUP BY 1 ORDER BY 1`, { h: 8, w: 8, x: 8, y },
{ stacked: true, decimals: 1, description: 'Quantas cópias da imagem estão sendo codificadas ao mesmo tempo, em média. Pelo processador pesa no jogo.' }));
add(series('FPS de quem transmite (app)', `
  SELECT $__timeGroupAlias(time, '15m', NULL), avg(capture_fps) AS "captura", avg(pipeline_fps) AS "depois do redesenho", avg(sent_fps) AS "enviado"
  FROM monitoring.host_quality WHERE $__timeFilter(time) GROUP BY 1 ORDER BY 1`, { h: 8, w: 8, x: 16, y }, { decimals: 0 }));
y += 8;
add(series('Aperto no PC de quem transmite', `
  SELECT $__timeGroupAlias(time, '15m', NULL), 100.0 * avg(CASE WHEN auto_fps THEN 1 ELSE 0 END) AS "em 30 fps automático",
    100.0 * avg(CASE WHEN cpu_limited THEN 1 ELSE 0 END) AS "limitado pelo processador",
    100.0 * avg(CASE WHEN bandwidth_limited THEN 1 ELSE 0 END) AS "limitado pela internet"
  FROM monitoring.host_quality WHERE $__timeFilter(time) GROUP BY 1 ORDER BY 1`, { h: 8, w: 12, x: 0, y },
{ unit: 'percent', decimals: 0, description: 'Parte dos minutos transmitidos em cada situação.' }));
add(table('Placas de vídeo de quem transmite', `
  SELECT coalesce(gpu_model, '?') AS placa, count(*) AS minutos,
    round(100.0 * sum(links_cpu) / nullif(sum(links), 0), 0) AS "% no processador",
    round(avg(sent_fps), 0) AS "fps enviado", round(100.0 * avg(CASE WHEN auto_fps THEN 1 ELSE 0 END), 0) AS "% em 30 automático"
  FROM monitoring.host_quality WHERE $__timeFilter(time) GROUP BY 1 ORDER BY 2 DESC LIMIT 15`, { h: 8, w: 12, x: 12, y }));
y += 8;
add(pie('Sistema de quem transmite pelo app', `
  SELECT platform AS sistema, count(*) AS minutos FROM monitoring.host_quality WHERE $__timeFilter(time) GROUP BY 1 ORDER BY 2 DESC`, { h: 7, w: 8, x: 0, y }));
add(table('Pelo navegador', `
  SELECT browser || ' (' || platform || ')' AS navegador, count(*) AS minutos, round(avg(sent_fps), 0) AS "fps enviado",
    round(100.0 * avg(CASE WHEN auto_fps THEN 1 ELSE 0 END), 0) AS "% em 30 automático",
    round(100.0 * avg(CASE WHEN piped THEN 1 ELSE 0 END), 0) AS "% pela placa de vídeo",
    round(100.0 * avg(CASE WHEN mode = 'sfu' THEN 1 ELSE 0 END), 0) AS "% no servidor de mídia"
  FROM monitoring.web_host_quality WHERE $__timeFilter(time) GROUP BY 1 ORDER BY 2 DESC`, { h: 7, w: 16, x: 8, y }));
y += 7;

// ---------------- Erros ----------------
add(row('Erros'));
add(series('Erros por hora', `
  SELECT $__timeGroupAlias(time, '1h', 0), origin AS metric, count(*) AS value FROM monitoring.errors
  WHERE $__timeFilter(time) GROUP BY 1, 2 ORDER BY 1`, { h: 8, w: 24, x: 0, y }, { stacked: true, decimals: 0 }));
y += 8;
add(table('Erros mais comuns', `
  SELECT message AS erro, origin AS onde, string_agg(DISTINCT coalesce(app_version, '?'), ', ') AS "versões", count(*) AS vezes, max(time) AS "último"
  FROM monitoring.errors WHERE $__timeFilter(time) GROUP BY 1, 2 ORDER BY 4 DESC LIMIT 30`, { h: 10, w: 14, x: 0, y }));
add(table('Erros novos', `
  SELECT e.message AS erro, e.origin AS onde, count(*) AS vezes, min(e.time) AS "primeira vez"
  FROM monitoring.errors e
  WHERE $__timeFilter(e.time) AND NOT EXISTS (
    SELECT 1 FROM monitoring.errors o WHERE o.message = e.message AND o.time < $__timeFrom()::timestamptz AND o.time > $__timeFrom()::timestamptz - interval '30 days')
  GROUP BY 1, 2 ORDER BY 4 DESC LIMIT 30`, { h: 10, w: 10, x: 14, y },
{ description: 'Erros do período escolhido que não apareceram nos 30 dias antes dele: o que uma versão nova trouxe.' }));
y += 10;

// ---------------- Cloudflare ----------------
add(row('Cloudflare'));
add(series('Uso no mês', `
  SELECT $__timeGroupAlias(time, '1h', NULL), max(cloudflare_gb) AS "total", max(cloudflare_sfu_gb) AS "servidor de mídia", max(cloudflare_relay_gb) AS "relay (TURN)"
  FROM monitoring.server_stats WHERE $__timeFilter(time) AND cloudflare_gb IS NOT NULL GROUP BY 1 ORDER BY 1`, { h: 8, w: 24, x: 0, y },
{ unit: 'decgbytes', decimals: 1, thresholdLine: 900, description: 'Acumulado do mês, como a Cloudflare conta. A linha vermelha é o limite do servidor (900 GB).' }));
y += 8;

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
  refresh: '5m',
  time: { from: 'now-24h', to: 'now' },
  timepicker: {},
  schemaVersion: 39,
  version: 1,
  templating: { list: [] },
  annotations: { list: [] },
  links: [],
  panels
};

const out = path.join(__dirname, 'grafana-dashboard.json');
fs.writeFileSync(out, JSON.stringify(dashboard, null, 2) + '\n');
console.log(`${panels.length} painéis -> ${out}`);
