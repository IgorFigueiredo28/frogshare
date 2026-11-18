// Talks to the FrogShare Grafana with a service account token, so nothing has to be clicked by hand:
//   node monitoring/grafana-sync.js check   runs every panel's query against the real data (reads only)
//   node monitoring/grafana-sync.js apply   check, then import the dashboard into the "FrogShare" folder and
//                                          create the alerts with their Discord contact point
// Reads GRAFANA_URL, GRAFANA_TOKEN and DISCORD_WEBHOOK_URL from .env.local (never printed). The alerting
// API needs a service account with the Admin role.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const env = {};
try {
  for (const line of fs.readFileSync(path.join(root, '.env.local'), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
} catch {}
const URL_ = (process.env.GRAFANA_URL || env.GRAFANA_URL || '').replace(/\/+$/, '');
const TOKEN = process.env.GRAFANA_TOKEN || env.GRAFANA_TOKEN || '';
const DISCORD = process.env.DISCORD_WEBHOOK_URL || env.DISCORD_WEBHOOK_URL || '';
const mode = process.argv[2] || 'check';
if (!URL_ || !TOKEN) { console.error('Faltam GRAFANA_URL e GRAFANA_TOKEN no .env.local (veja monitoring/README.md).'); process.exit(1); }

const FOLDER = { uid: 'frogshare', title: 'FrogShare' };
const CONTACT = 'FrogShare Discord';

async function api(method, p, body, extraHeaders = {}) {
  const res = await fetch(URL_ + p, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', Accept: 'application/json', ...extraHeaders },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    const msg = (data && (data.message || data.error)) || String(text).slice(0, 300);
    const err = new Error(`${method} ${p} -> ${res.status}: ${msg}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

// The PostgreSQL connection to Supabase: the one named FrogShare, or the first that answers
async function findDatasource() {
  const list = (await api('GET', '/api/datasources')).filter(d => /postgres/i.test(d.type));
  if (!list.length) throw new Error('Nenhuma conexão PostgreSQL no Grafana.');
  list.sort((a, b) => Number(/frogshare/i.test(b.name)) - Number(/frogshare/i.test(a.name)));
  for (const d of list) {
    try {
      const h = await api('GET', `/api/datasources/uid/${d.uid}/health`);
      if (String(h.status).toUpperCase() === 'OK') return d;
    } catch {}
  }
  throw new Error('Nenhuma conexão PostgreSQL respondeu "OK" (confira a senha do grafana_reader).');
}

// Every query of the dashboard, as Grafana's backend runs it; the version filter is set to "all"
function dashboardQueries(dash) {
  const out = [];
  const visit = (p) => {
    for (const t of p.targets || []) out.push({ title: p.title, sql: t.rawSql, format: t.format });
    for (const inner of p.panels || []) visit(inner);
  };
  dash.panels.forEach(visit);
  for (const a of dash.annotations.list) if (a.target?.rawSql) out.push({ title: 'anotação: ' + a.name, sql: a.target.rawSql, format: 'table' });
  for (const v of dash.templating.list) out.push({ title: 'variável: ' + v.name, sql: v.query, format: 'table' });
  return out.map(q => ({ ...q, sql: q.sql.replace(/\$versao/g, "'__all'") }));
}

async function runQuery(ds, sql, format, from = 'now-24h') {
  const res = await api('POST', '/api/ds/query', {
    from, to: 'now',
    queries: [{ refId: 'A', datasource: { uid: ds.uid, type: ds.type }, rawSql: sql, format, rawQuery: true, editorMode: 'code', intervalMs: 60000, maxDataPoints: 500 }]
  }).catch(err => ({ results: { A: { error: err.message } } }));
  const r = res?.results?.A || {};
  const rows = (r.frames || []).reduce((n, f) => n + ((f.data?.values?.[0] || []).length), 0);
  return { error: r.error || null, rows };
}

async function check(ds) {
  const dash = JSON.parse(fs.readFileSync(path.join(__dirname, 'grafana-dashboard.json'), 'utf8'));
  let failed = 0;
  for (const q of dashboardQueries(dash)) {
    const r = await runQuery(ds, q.sql, q.format);
    if (r.error) failed++;
    console.log(`${r.error ? 'ERRO ' : 'ok   '} ${q.title}${r.error ? ' -> ' + r.error : ` (${r.rows} linhas)`}`);
  }
  for (const rule of alertRules(ds)) {
    const r = await runQuery(ds, rule.data[0].model.rawSql, 'table', 'now-1h');
    if (r.error) failed++;
    console.log(`${r.error ? 'ERRO ' : 'ok   '} alerta: ${rule.title}${r.error ? ' -> ' + r.error : ` (${r.rows} linhas)`}`);
  }
  return failed;
}

// ---------------- Alerts ----------------
// Each one: a query returning numbers (string columns become labels, one alert per row), the last value,
// a threshold. Evaluated every 5 minutes; messages go to the Discord channel.
function alertRules(ds) {
  const rule = (uid, title, sql, op, value, { forDur = '0s', summary, severity = 'aviso', windowSec = 3600 }) => ({
    uid, title, ruleGroup: 'frogshare', folderUID: FOLDER.uid, orgID: 1, condition: 'C', for: forDur,
    noDataState: 'OK', execErrState: 'KeepLast', isPaused: false,
    labels: { app: 'frogshare', gravidade: severity },
    annotations: { summary },
    notification_settings: { receiver: CONTACT },
    data: [
      { refId: 'A', relativeTimeRange: { from: windowSec, to: 0 }, datasourceUid: ds.uid,
        model: { refId: 'A', datasource: { uid: ds.uid, type: ds.type }, rawSql: sql.trim().replace(/\s+/g, ' '), format: 'table', rawQuery: true, editorMode: 'code', intervalMs: 60000, maxDataPoints: 43200 } },
      { refId: 'B', relativeTimeRange: { from: 0, to: 0 }, datasourceUid: '__expr__',
        model: { refId: 'B', type: 'reduce', expression: 'A', reducer: 'last', settings: { mode: 'dropNN' }, datasource: { type: '__expr__', uid: '__expr__' } } },
      { refId: 'C', relativeTimeRange: { from: 0, to: 0 }, datasourceUid: '__expr__',
        model: { refId: 'C', type: 'threshold', expression: 'B', conditions: [{ evaluator: { type: op, params: [value] } }], datasource: { type: '__expr__', uid: '__expr__' } } }
    ]
  });
  return [
    rule('frogshare-erro-novo', 'Erro novo', `
      SELECT e.message AS erro, e.origin AS onde, count(*) AS vezes FROM monitoring.errors e
      WHERE e.time > now() - interval '1 hour' AND NOT EXISTS (
        SELECT 1 FROM monitoring.errors o WHERE o.message = e.message AND o.time <= now() - interval '1 hour' AND o.time > now() - interval '31 days')
      GROUP BY 1, 2`, 'gt', 0, {
      summary: 'Erro que não aparecia há 30 dias ({{ $labels.onde }}): {{ $labels.erro }}. {{ $values.B }} vez(es) na última hora.'
    }),
    rule('frogshare-muitos-erros', 'Muitos erros', `
      SELECT count(*) AS erros FROM monitoring.errors WHERE time > now() - interval '1 hour'`, 'gt', 20, {
      summary: '{{ $values.B }} erros na última hora (o normal é bem menos de 20).'
    }),
    rule('frogshare-travadas', 'Quem assiste está travando', `
      SELECT CASE WHEN count(*) >= 20 THEN avg(frozen_s) ELSE 0 END AS segundos
      FROM monitoring.viewer_quality WHERE time > now() - interval '30 minutes'`, 'gt', 8, {
      forDur: '10m', windowSec: 1800,
      summary: 'Nos últimos 30 minutos a imagem ficou parada em média {{ printf "%.1f" $values.B.Value }} s por minuto para quem assiste.'
    }),
    rule('frogshare-cloudflare-70', 'Cloudflare passou de 70% do mês', `
      SELECT 100.0 * cloudflare_gb / nullif(cloudflare_cap_gb, 0) AS porcento FROM monitoring.server_stats
      WHERE cloudflare_gb IS NOT NULL AND time > now() - interval '2 days' ORDER BY time DESC LIMIT 1`, 'gt', 70, {
      windowSec: 172800, summary: 'A Cloudflare está em {{ printf "%.0f" $values.B.Value }}% do limite do mês (900 GB).'
    }),
    rule('frogshare-cloudflare-90', 'Cloudflare passou de 90% do mês', `
      SELECT 100.0 * cloudflare_gb / nullif(cloudflare_cap_gb, 0) AS porcento FROM monitoring.server_stats
      WHERE cloudflare_gb IS NOT NULL AND time > now() - interval '2 days' ORDER BY time DESC LIMIT 1`, 'gt', 90, {
      severity: 'urgente', windowSec: 172800,
      summary: 'A Cloudflare está em {{ printf "%.0f" $values.B.Value }}% do limite do mês: perto de 900 GB o servidor deixa de usar relay e servidor de mídia.'
    })
  ];
}

async function apply(ds) {
  // Folder (an Editor token may create it and still not be let into it: then the dashboard stays at the root)
  const folders = await api('GET', '/api/folders');
  if (!folders.some(f => f.uid === FOLDER.uid)) await api('POST', '/api/folders', FOLDER).catch(err => console.log('pasta: ' + err.message));
  const folderOk = await api('GET', `/api/folders/${FOLDER.uid}`).then(f => f.canSave !== false, () => false);

  // Dashboard
  const dash = JSON.parse(fs.readFileSync(path.join(__dirname, 'grafana-dashboard.json'), 'utf8'));
  await api('POST', '/api/dashboards/import', {
    dashboard: dash, overwrite: true, ...(folderOk ? { folderUid: FOLDER.uid } : {}),
    inputs: [{ name: 'DS_FROGSHARE', type: 'datasource', pluginId: 'grafana-postgresql-datasource', value: ds.uid }]
  });
  console.log(`painel importado${folderOk ? ' na pasta FrogShare' : ' na pasta raiz'}: ${URL_}/d/${dash.uid}`);

  // Contact point (editable in the UI afterwards)
  const noProvenance = { 'X-Disable-Provenance': 'true' };
  // One contact with that name is enough: one made by hand in the UI is kept as it is (a second integration
  // under the same name would send every alert twice)
  const points = await api('GET', '/api/v1/provisioning/contact-points');
  let toDiscord = points.some(p => p.name === CONTACT);
  const handMade = points.some(p => p.name === CONTACT && p.uid !== 'frogshare-discord');
  if (DISCORD && !handMade) {
    const body = { uid: 'frogshare-discord', name: CONTACT, type: 'discord', settings: { url: DISCORD, use_discord_username: false }, disableResolveMessage: false };
    if (points.some(p => p.uid === body.uid)) await api('PUT', `/api/v1/provisioning/contact-points/${body.uid}`, body, noProvenance);
    else await api('POST', '/api/v1/provisioning/contact-points', body, noProvenance);
    toDiscord = true;
    console.log('contato do Discord ok');
  } else if (handMade) {
    console.log('contato do Discord: usando o "FrogShare Discord" que já existe');
  }

  // Alerts, as one group evaluated every 5 minutes. Without the Discord contact they follow the default
  // notification policy (the account's e-mail in a new Grafana Cloud stack).
  const rules = alertRules(ds).map(r => {
    if (toDiscord) return r;
    const { notification_settings: _, ...rest } = r;
    return rest;
  });
  await api('PUT', `/api/v1/provisioning/folder/${FOLDER.uid}/rule-groups/frogshare`, {
    title: 'frogshare', folderUid: FOLDER.uid, interval: 300, rules
  }, noProvenance);
  console.log(`alertas ok (${toDiscord ? 'avisam no Discord' : 'avisam no e-mail da conta; com DISCORD_WEBHOOK_URL passam para o Discord'}): ${rules.map(r => r.title).join(', ')}`);
}

(async () => {
  const ds = await findDatasource();
  console.log(`conexão: ${ds.name}`);
  const failed = await check(ds);
  if (mode === 'apply') {
    if (failed) { console.log(`\n${failed} consulta(s) com erro: nada foi importado.`); process.exit(1); }
    try {
      await apply(ds);
    } catch (err) {
      if (err.status === 403 && /provisioning|folder/.test(err.message)) {
        console.log(`\nO Grafana recusou: ${err.message}\nPara criar os alertas, o token precisa do papel Admin: Administration > Users and access > Service accounts > claude-frogshare > Role: Admin.`);
        process.exit(1);
      }
      throw err;
    }
  }
  console.log(failed ? `\n${failed} consulta(s) com erro` : '\ntudo certo');
  process.exit(failed ? 1 : 0);
})().catch(err => { console.error(err.message); process.exit(1); });
