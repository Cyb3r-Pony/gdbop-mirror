// Logic behind scripts/intel.mjs, kept free of process/terminal I/O so tests
// can run it against SQLite directly.
//
// Every value that reaches SQL is written as CAST(X'<utf-8 hex>' AS TEXT): no
// quotes and no semicolons, so neither a search term nor a value stored from a
// report can change the statement (wrangler's `d1 execute --command` takes plain
// SQL text, without bound parameters). Each query is one SELECT returning JSON.
import { createHash } from 'node:crypto';
import { CRIME_TYPES } from '../src/schema.js';
import { REPORT_ID_RE } from '../src/files.js';
import {
  extractIndicators, refang, unseal, reporterMacs, normalizeReporter, normalizeName, retentionCutoff, KIND_LABELS,
} from '../src/intel.js';

export const MAX_REPORTS = 300;
const KINDS = Object.keys(KIND_LABELS);

export const lit = (s) => `CAST(X'${Buffer.from(String(s), 'utf8').toString('hex')}' AS TEXT)`;
const list = (values) => values.map(lit).join(', ');
const pairsWhere = (inds) => inds.map((i) => `(i.kind = ${lit(i.kind)} AND i.value = ${lit(i.value)})`).join(' OR ');
const parse = (s, fallback) => (s ? JSON.parse(s) : fallback);
const crimeLabel = (id) => CRIME_TYPES.find((c) => c.id === id)?.bg ?? id;

// `exec(sql)` runs one statement and resolves to its rows.
const one = async (exec, sql) => (await exec(sql))[0] ?? {};

// --- seeds -------------------------------------------------------------------

// The identifiers a free-text search may mean: whatever it parses as, the raw
// value under every kind, and (from 4 characters) a substring match.
export const findSeeds = async (exec, q) => {
  const plain = refang(q).trim();
  const parsed = await extractIndicators([plain]);
  const exact = [...parsed, ...KINDS.map((kind) => ({ kind, value: plain.toLowerCase().replace(/^@/, '') }))];
  const like = plain.length >= 4 ? `%${plain.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
  const where = `${pairsWhere(exact)}${like ? ` OR LOWER(i.value) LIKE ${lit(like)} ESCAPE ${lit('\\')}` : ''}`;
  const row = await one(exec, `SELECT (SELECT json_group_array(json_object('kind', kind, 'value', value)) FROM (SELECT i.kind, i.value FROM indicators i WHERE ${where} LIMIT 50)) AS seeds`);
  return parse(row.seeds, []);
};

export const topSeeds = async (exec, days, now) => {
  const since = new Date(now.getTime() - days * 24 * 3600 * 1000).toISOString();
  const row = await one(
    exec,
    `SELECT (SELECT json_group_array(json_object('kind', kind, 'value', value)) FROM (
       SELECT i.kind, i.value, COUNT(*) AS n FROM indicators i JOIN report_indicators ri ON ri.indicator_id = i.id
       JOIN reports r ON r.id = ri.report_id WHERE r.received_at >= ${lit(since)}
       GROUP BY i.id HAVING COUNT(*) >= 2 ORDER BY n DESC LIMIT 50)) AS seeds`,
  );
  return parse(row.seeds, []);
};

// Reports of one reporter (name, phone or email). Also checks the HMAC key
// against a stored row, so a wrong key is reported instead of "no results".
export const reporterIds = async (exec, { kind, q, hmacSecret, encKey, cutoff }) => {
  const value = normalizeReporter(kind, q);
  if (!value) throw new UserError('Невалидна стойност за това търсене.');
  const mac = (await reporterMacs(hmacSecret, { [kind]: q }))[kind];
  const row = await one(
    exec,
    `SELECT (SELECT json_group_array(id) FROM (SELECT r.id AS id FROM reporter_keys k JOIN reports r ON r.id = k.report_id
       WHERE k.kind = ${lit(kind)} AND k.mac = ${lit(mac)}${cutoff ? ` AND r.received_at >= ${lit(cutoff)}` : ''}
       ORDER BY r.received_at DESC LIMIT ${MAX_REPORTS})) AS ids,
     (SELECT json_object('id', k.report_id, 'mac', k.mac, 'sealed', d.sealed) FROM reporter_keys k
       JOIN reporter_data d ON d.report_id = k.report_id WHERE k.kind = ${lit(kind)} LIMIT 1) AS probe`,
  );
  const probe = parse(row.probe, null);
  if (probe) {
    const data = await unseal(encKey, probe.id, probe.sealed);
    if (!data) throw new UserError('Ключът за криптиране (INTEL_ENC_KEY) не пасва на базата.');
    const field = { name: 'fullName', phone: 'phone', email: 'email' }[kind];
    if ((await reporterMacs(hmacSecret, { [kind]: data[field] }))[kind] !== probe.mac) {
      throw new UserError('HMAC ключът (INTEL_HMAC_KEY) не пасва на базата: търсенето по подател няма да намери нищо.');
    }
  }
  return { ids: parse(row.ids, []), mac };
};

export class UserError extends Error {}

// --- expansion and loading ---------------------------------------------------------

// Reports linked to any of these identifiers, newest first.
export const idsForIndicators = async (exec, inds) => {
  if (!inds.length) return [];
  const row = await one(
    exec,
    `SELECT (SELECT json_group_array(id) FROM (SELECT DISTINCT r.id AS id, r.received_at FROM indicators i
       JOIN report_indicators ri ON ri.indicator_id = i.id JOIN reports r ON r.id = ri.report_id
       WHERE ${pairsWhere(inds)} ORDER BY r.received_at DESC LIMIT ${MAX_REPORTS})) AS ids`,
  );
  return parse(row.ids, []);
};

export const loadReports = async (exec, ids) => {
  if (!ids.length) return { reports: [], links: [] };
  const row = await one(
    exec,
    `SELECT
       (SELECT json_group_array(json_object('id', r.id, 'at', r.received_at, 'type', r.crime_type, 'purged', r.reporter_purged_at, 'sealed', d.sealed))
          FROM reports r LEFT JOIN reporter_data d ON d.report_id = r.id WHERE r.id IN (${list(ids)})) AS reports,
       (SELECT json_group_array(json_object('report', ri.report_id, 'kind', i.kind, 'value', i.value,
          'total', (SELECT COUNT(*) FROM report_indicators x WHERE x.indicator_id = i.id)))
          FROM report_indicators ri JOIN indicators i ON i.id = ri.indicator_id WHERE ri.report_id IN (${list(ids)})) AS links`,
  );
  return { reports: parse(row.reports, []), links: parse(row.links, []) };
};

export const auditSql = ({ at, who, action, query }) =>
  `INSERT INTO audit_log (at, who, action, query) VALUES (${lit(at.toISOString())}, ${lit(who)}, ${lit(action)}, ${lit(String(query).slice(0, 300))})`;

// --- the whole search ------------------------------------------------------------

const keyOf = (kind, value) => `${kind}\u0000${value}`;

// Runs a search and returns the model the outputs render.
// opts: { kind: find|report|name|phone|email|top, q, depth, days, encKey, hmacSecret, retentionDays, now, who }
export const runSearch = async (exec, opts) => {
  const { kind, q, now } = opts;
  const cutoff = retentionCutoff({ REPORTER_RETENTION_DAYS: String(opts.retentionDays) }, now);
  let seeds = [];
  let ids = [];
  let auditQuery = q;

  if (kind === 'find') {
    seeds = await findSeeds(exec, q);
    ids = await idsForIndicators(exec, seeds);
  } else if (kind === 'top') {
    seeds = await topSeeds(exec, opts.days, now);
    ids = await idsForIndicators(exec, seeds);
    auditQuery = String(opts.days);
  } else if (kind === 'report') {
    const id = String(q).trim().toUpperCase();
    if (!REPORT_ID_RE.test(id)) throw new UserError('Невалиден номер на сигнал (очаква се MVR-GDBOP-ГГГГММДД-XXXXX).');
    ids = [id];
    auditQuery = id;
  } else if (kind === 'name' || kind === 'phone' || kind === 'email') {
    const r = await reporterIds(exec, { kind, q, hmacSecret: opts.hmacSecret, encKey: opts.encKey, cutoff });
    ids = r.ids;
    auditQuery = `hmac:${r.mac}`; // the log never holds the reporter's data
  } else {
    throw new UserError(`Непознат вид търсене: ${kind}`);
  }
  await exec(auditSql({ at: now, who: opts.who, action: kind, query: auditQuery }));

  // depth 2+: also the reports that share any identifier with those found
  let loaded = await loadReports(exec, ids);
  for (let d = 2; d <= opts.depth && ids.length < MAX_REPORTS; d += 1) {
    const inds = [...new Map(loaded.links.map((l) => [keyOf(l.kind, l.value), { kind: l.kind, value: l.value }])).values()];
    const more = (await idsForIndicators(exec, inds)).filter((id) => !ids.includes(id));
    if (!more.length) break;
    ids = [...ids, ...more].slice(0, MAX_REPORTS);
    loaded = await loadReports(exec, ids);
  }
  return buildModel(loaded, { ...opts, seeds, cutoff, truncated: ids.length >= MAX_REPORTS });
};

export const buildModel = async (loaded, { kind, q, depth, encKey, cutoff, seeds, now, truncated }) => {
  const reports = [];
  for (const r of [...loaded.reports].sort((a, b) => (a.at < b.at ? 1 : -1))) {
    const inTerm = !cutoff || r.at >= cutoff;
    const reporter = encKey && r.sealed && inTerm ? await unseal(encKey, r.id, r.sealed) : null;
    reports.push({
      id: r.id,
      at: r.at,
      type: crimeLabel(r.type),
      reporter,
      purged: Boolean(r.purged) || !inTerm,
      indicators: loaded.links.filter((l) => l.report === r.id).map((l) => keyOf(l.kind, l.value)),
    });
  }
  // A sealed row within the term that does not open means the wrong key, not missing data.
  if (encKey && reports.some((r) => !r.purged && !r.reporter && loaded.reports.find((x) => x.id === r.id)?.sealed)) {
    throw new UserError('Ключът за криптиране (INTEL_ENC_KEY) не пасва на базата.');
  }
  const reporterKey = (r) => (r.reporter ? r.reporter.phone || normalizeName(r.reporter.fullName) : null);
  const seedKeys = new Set(seeds.map((s) => keyOf(s.kind, s.value)));
  const indicators = new Map();
  for (const l of loaded.links) {
    const key = keyOf(l.kind, l.value);
    if (!indicators.has(key)) {
      indicators.set(key, { key, kind: l.kind, label: KIND_LABELS[l.kind] ?? l.kind, value: l.value, total: l.total, inResult: 0, reporters: 0, seed: seedKeys.has(key) });
    }
  }
  for (const ind of indicators.values()) {
    const rs = reports.filter((r) => r.indicators.includes(ind.key));
    ind.inResult = rs.length;
    ind.reporters = new Set(rs.map((r) => reporterKey(r) ?? r.id)).size;
  }
  return {
    query: { kind, q, depth },
    generatedAt: now.toISOString(),
    truncated,
    reports,
    indicators: [...indicators.values()].sort((a, b) => b.seed - a.seed || b.total - a.total || a.value.localeCompare(b.value)),
  };
};

// --- outputs -------------------------------------------------------------------

const KIND_TITLES = { find: 'идентификатор', top: 'най-подавани', report: 'сигнал', name: 'подател (имена)', phone: 'подател (телефон)', email: 'подател (имейл)' };
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const day = (iso) => (iso ? iso.slice(0, 10) : '');

const cut = (s, w) => {
  const chars = [...String(s ?? '')];
  return chars.length > w ? `${chars.slice(0, w - 1).join('')}…` : chars.join('');
};
const table = (headers, rows, widths) => {
  const fmt = (cells) => cells.map((c, i) => cut(c, widths[i]).padEnd(widths[i])).join('  ').trimEnd();
  return [fmt(headers), widths.map((w) => '─'.repeat(w)).join('  '), ...rows.map(fmt)].join('\n');
};

export const renderTables = (m) => {
  const out = [];
  const reporters = new Set(m.reports.map((r) => (r.reporter ? r.reporter.phone : r.id))).size;
  out.push(`Търсене: ${KIND_TITLES[m.query.kind]} ${m.query.kind === 'top' ? '' : `„${m.query.q}“`}  (дълбочина ${m.query.depth})`);
  out.push(`${plural(m.reports.length, 'сигнал', 'сигнала')}, ${plural(m.indicators.length, 'идентификатор', 'идентификатора')}, ${reporters} различни податели${m.truncated ? `  (показани са първите ${MAX_REPORTS})` : ''}`);
  if (!m.reports.length) return `${out.join('\n')}\nНяма резултати.`;
  out.push('', 'СИГНАЛИ');
  out.push(table(
    ['Сигнал', 'Дата', 'Вид', 'Подател', 'Телефон', 'Имейл'],
    m.reports.map((r) => [r.id, day(r.at), r.type, r.reporter ? r.reporter.fullName : r.purged ? '(изтрити по срок)' : '-', r.reporter?.phone ?? '', r.reporter?.email ?? '']),
    [24, 10, 24, 28, 15, 30],
  ));
  out.push('', 'ИДЕНТИФИКАТОРИ  (* = търсеният)');
  out.push(table(
    ['Вид', 'Стойност', 'Общо', 'Тук', 'Податели'],
    m.indicators.map((i) => [`${i.seed ? '* ' : ''}${i.label}`, i.value, i.total, i.inResult, i.reporters]),
    [20, 46, 5, 4, 8],
  ));
  return out.join('\n');
};

// One row per report and identifier (the shape pivot tables want). Cells that a
// spreadsheet would read as a formula get a leading apostrophe.
export const renderCsv = (m) => {
  const cell = (v) => {
    let s = String(v ?? '');
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\n\r;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const byKey = new Map(m.indicators.map((i) => [i.key, i]));
  const rows = [['report_id', 'date', 'crime_type', 'reporter_name', 'reporter_phone', 'reporter_email', 'identifier_kind', 'identifier', 'identifier_reports_total']];
  for (const r of m.reports) {
    const base = [r.id, day(r.at), r.type, r.reporter?.fullName ?? (r.purged ? '(изтрити по срок)' : ''), r.reporter?.phone ?? '', r.reporter?.email ?? ''];
    const inds = r.indicators.map((k) => byKey.get(k)).filter(Boolean);
    if (!inds.length) rows.push([...base, '', '', '']);
    for (const i of inds) rows.push([...base, i.label, i.value, i.total]);
  }
  return `﻿${rows.map((r) => r.map(cell).join(',')).join('\r\n')}\r\n`; // BOM: Excel reads it as UTF-8
};

const sha = (s) => createHash('sha256').update(s, 'utf8').digest('base64');

// A single offline file: inline CSS/JS allowed only by hash, no network at all.
export const renderHtml = (m) => {
  const data = JSON.stringify(m).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  const csp = `default-src 'none'; style-src '${'sha256-'}${sha(HTML_CSS)}'; script-src 'sha256-${sha(HTML_JS)}'; img-src data:; base-uri 'none'; form-action 'none'`;
  return `<!doctype html>
<html lang="bg">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Връзки между сигналите</title>
<style>${HTML_CSS}</style>
</head>
<body>
<header>
  <h1>Връзки между сигналите</h1>
  <p class="warn">Съдържа лични данни. Не препращайте файла и го изтрийте след работа.</p>
  <p id="summary" class="muted"></p>
</header>
<main>
  <section class="graph-box">
    <div class="legend"><span class="dot rep"></span>сигнал <span class="dot ind"></span>идентификатор <span class="dot seed"></span>търсеният <span class="dot per"></span>подател
      <span class="muted">· клик върху точка показва връзките ѝ, клик в празното ги изчиства · колелце/два пръста: мащаб, влачене: местене</span></div>
    <svg id="graph" role="img" aria-label="Графика на връзките"></svg>
  </section>
  <input id="filter" type="search" placeholder="Филтър в таблиците (номер, име, телефон, сайт, IBAN...)" aria-label="Филтър">
  <h2>Сигнали</h2>
  <div class="wrap"><table id="reports"><thead><tr><th>Сигнал</th><th>Дата</th><th>Вид</th><th>Подател</th><th>Телефон</th><th>Имейл</th><th>Идентификатори</th></tr></thead><tbody></tbody></table></div>
  <h2>Идентификатори</h2>
  <div class="wrap"><table id="indicators"><thead><tr><th>Вид</th><th>Стойност</th><th>Сигнали общо</th><th>В резултата</th><th>Податели</th></tr></thead><tbody></tbody></table></div>
</main>
<script type="application/json" id="data">${data}</script>
<script>${HTML_JS}</script>
</body>
</html>
`;
};

const HTML_CSS = `
:root { color-scheme: light dark; --bg: #f8fafc; --fg: #0f172a; --muted: #64748b; --card: #fff; --line: #e2e8f0; --rep: #2563eb; --ind: #ea580c; --seed: #dc2626; --per: #16a34a; --edge: #94a3b8; }
@media (prefers-color-scheme: dark) { :root { --bg: #0b1220; --fg: #e2e8f0; --muted: #94a3b8; --card: #111a2e; --line: #1e293b; --rep: #60a5fa; --ind: #fb923c; --seed: #f87171; --per: #4ade80; --edge: #475569; } }
* { box-sizing: border-box; }
body { margin: 0; padding: 16px; background: var(--bg); color: var(--fg); font: 14px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
header, main { max-width: 1200px; margin: 0 auto; }
h1 { font-size: 22px; margin: 4px 0; }
h2 { font-size: 16px; margin: 24px 0 8px; }
.muted { color: var(--muted); }
.warn { color: var(--seed); font-weight: 600; margin: 4px 0; }
.graph-box { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 8px; margin-top: 12px; }
.legend { font-size: 12px; display: flex; flex-wrap: wrap; gap: 4px 10px; align-items: center; padding: 4px; }
.dot { display: inline-block; width: 10px; height: 10px; border-radius: 50%; margin-right: 3px; vertical-align: -1px; }
.dot.rep { background: var(--rep); } .dot.ind { background: var(--ind); } .dot.seed { background: var(--seed); } .dot.per { background: var(--per); }
svg { width: 100%; height: 560px; display: block; cursor: grab; touch-action: none; }
svg .edge { stroke: var(--edge); stroke-width: 1; vector-effect: non-scaling-stroke; }
svg .node { cursor: pointer; stroke: var(--card); stroke-width: 1.5; vector-effect: non-scaling-stroke; }
svg .rep { fill: var(--rep); } svg .ind { fill: var(--ind); } svg .seed { fill: var(--seed); } svg .per { fill: var(--per); }
svg text { fill: var(--fg); pointer-events: none; paint-order: stroke; stroke: var(--card); }
svg .dim { opacity: .12; }
input { width: 100%; margin-top: 16px; font: inherit; padding: 8px 10px; border-radius: 8px; border: 1px solid var(--line); background: var(--card); color: var(--fg); }
.wrap { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; background: var(--card); border: 1px solid var(--line); }
th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--line); vertical-align: top; }
th { font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); white-space: nowrap; }
td.nowrap { white-space: nowrap; }
td.value { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; word-break: break-all; }
tr.sel td { background: color-mix(in srgb, var(--seed) 12%, transparent); }
tr { cursor: pointer; }
`;

const HTML_JS = `
(() => {
  'use strict';
  const m = JSON.parse(document.getElementById('data').textContent);
  const NS = 'http://www.w3.org/2000/svg';
  const $ = (id) => document.getElementById(id);
  const el = (tag, props = {}, ...kids) => { const n = document.createElement(tag); Object.assign(n, props); n.append(...kids); return n; };
  const sv = (tag, attrs = {}) => { const n = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v); return n; };
  const day = (s) => (s ? s.slice(0, 10) : '');
  const short = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
  const indByKey = new Map(m.indicators.map((i) => [i.key, i]));

  const reporters = new Set(m.reports.map((r) => (r.reporter ? r.reporter.phone : r.id))).size;
  const KINDS = { find: 'идентификатор', top: 'най-подавани', report: 'сигнал', name: 'подател (имена)', phone: 'подател (телефон)', email: 'подател (имейл)' };
  $('summary').textContent = 'Търсене: ' + (KINDS[m.query.kind] || m.query.kind) + (m.query.kind === 'top' ? '' : ' „' + m.query.q + '“') + ' · дълбочина ' + m.query.depth +
    ' · ' + m.reports.length + ' сигнала, ' + m.indicators.length + ' идентификатора, ' + reporters + ' различни податели · ' + m.generatedAt.slice(0, 16).replace('T', ' ') + ' UTC' +
    (m.truncated ? ' · показани са първите 300 сигнала' : '');

  // --- graph model: reports, identifiers, reporters (grouped by phone)
  const nodes = new Map();
  const edges = [];
  const add = (id, type, label, title) => { if (!nodes.has(id)) nodes.set(id, { id, type, label, title, links: new Set() }); return nodes.get(id); };
  const link = (a, b) => { edges.push([a, b]); nodes.get(a).links.add(b); nodes.get(b).links.add(a); };
  for (const r of m.reports) {
    add('r:' + r.id, 'rep', r.id.slice(-5), r.id + '\\n' + day(r.at) + ' · ' + r.type);
    if (r.reporter) {
      const pid = 'p:' + (r.reporter.phone || r.reporter.fullName);
      add(pid, 'per', r.reporter.fullName, r.reporter.fullName + '\\n' + r.reporter.phone + '\\n' + r.reporter.email);
      link('r:' + r.id, pid);
    }
    for (const k of r.indicators) {
      const i = indByKey.get(k);
      if (!i) continue;
      add('i:' + k, i.seed ? 'seed' : 'ind', short(i.value, 26), i.label + ': ' + i.value + '\\n' + i.total + ' сигнала общо');
      link('r:' + r.id, 'i:' + k);
    }
  }
  const list = [...nodes.values()];

  // --- force layout (Fruchterman-Reingold), deterministic start on a circle
  const W = 1000, H = 560;
  list.forEach((n, i) => { const a = (2 * Math.PI * i) / list.length; n.x = W / 2 + (W / 3) * Math.cos(a); n.y = H / 2 + (H / 3) * Math.sin(a); });
  const k = Math.min(Math.max(Math.sqrt((W * H) / Math.max(list.length, 1)) * 0.6, 35), 90); // ideal edge length
  let t = W / 8;
  const steps = list.length > 400 ? 120 : 300;
  for (let s = 0; s < steps; s += 1) {
    for (const n of list) { n.dx = 0; n.dy = 0; }
    for (let a = 0; a < list.length; a += 1) for (let b = a + 1; b < list.length; b += 1) {
      const p = list[a], q = list[b];
      let dx = p.x - q.x, dy = p.y - q.y; const d = Math.max(Math.hypot(dx, dy), 0.01); const f = (k * k) / d;
      dx = (dx / d) * f; dy = (dy / d) * f; p.dx += dx; p.dy += dy; q.dx -= dx; q.dy -= dy;
    }
    for (const [a, b] of edges) {
      const p = nodes.get(a), q = nodes.get(b);
      let dx = p.x - q.x, dy = p.y - q.y; const d = Math.max(Math.hypot(dx, dy), 0.01); const f = (d * d) / k;
      dx = (dx / d) * f; dy = (dy / d) * f; p.dx -= dx; p.dy -= dy; q.dx += dx; q.dy += dy;
    }
    for (const n of list) {
      n.dx += (W / 2 - n.x) * 0.05; n.dy += (H / 2 - n.y) * 0.05; // pull to the centre keeps separate groups in view
      const d = Math.max(Math.hypot(n.dx, n.dy), 0.01);
      n.x += (n.dx / d) * Math.min(d, t); n.y += (n.dy / d) * Math.min(d, t);
    }
    t *= 0.98;
  }

  // --- draw
  const svg = $('graph');
  const xs = list.map((n) => n.x), ys = list.map((n) => n.y);
  // fit everything, with room on the right for the labels
  const bw = list.length ? Math.max(...xs) - Math.min(...xs) : 0, bh = list.length ? Math.max(...ys) - Math.min(...ys) : 0;
  let view = list.length
    ? { x: Math.min(...xs) - bw * 0.06 - 20, y: Math.min(...ys) - bh * 0.08 - 20, w: bw * 1.45 + 80, h: bh * 1.16 + 40 }
    : { x: 0, y: 0, w: W, h: H };
  const gEdges = sv('g'), gNodes = sv('g');
  // points and labels keep the same size on screen at any zoom level
  const setView = () => {
    svg.setAttribute('viewBox', view.x + ' ' + view.y + ' ' + Math.max(view.w, 50) + ' ' + Math.max(view.h, 50));
    const s = Math.max(Math.max(view.w, 50) / (svg.clientWidth || 1000), Math.max(view.h, 50) / (svg.clientHeight || 560));
    gNodes.setAttribute('font-size', 12 * s);
    for (const n of list) {
      if (!n.c) continue;
      n.c.setAttribute('r', n.r * s);
      if (n.t) { n.t.setAttribute('x', n.x + (n.r + 3) * s); n.t.setAttribute('y', n.y + 4 * s); n.t.setAttribute('stroke-width', 3 * s); }
    }
  };
  svg.append(gEdges, gNodes);
  for (const [a, b] of edges) {
    const p = nodes.get(a), q = nodes.get(b);
    const line = sv('line', { x1: p.x, y1: p.y, x2: q.x, y2: q.y, class: 'edge' });
    line.dataset.a = a; line.dataset.b = b; gEdges.append(line);
  }
  for (const n of list) {
    const deg = n.links.size;
    n.r = n.type === 'rep' ? 5 : 5 + Math.min(deg, 6);
    const g = sv('g'); g.dataset.id = n.id;
    const c = sv('circle', { cx: n.x, cy: n.y, r: n.r, class: 'node ' + n.type });
    const title = sv('title'); title.textContent = n.title; c.append(title);
    g.append(c);
    n.c = c;
    if (n.type !== 'rep' || list.length < 60) {
      const tx = sv('text'); tx.textContent = n.label; g.append(tx); n.t = tx;
    }
    c.addEventListener('click', (e) => { e.stopPropagation(); select(n.id); });
    gNodes.append(g);
    n.g = g;
  }
  setView();
  window.addEventListener('resize', setView);

  // --- pan and zoom
  // dragging starts only on the background, so clicks on points stay clicks
  let drag = null;
  svg.addEventListener('pointerdown', (e) => { if (e.target === svg) drag = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y, moved: false }; });
  window.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const s = view.w / svg.clientWidth;
    if (Math.abs(e.clientX - drag.x) + Math.abs(e.clientY - drag.y) > 3) drag.moved = true;
    view.x = drag.vx - (e.clientX - drag.x) * s; view.y = drag.vy - (e.clientY - drag.y) * s; setView();
  });
  window.addEventListener('pointerup', () => { if (drag && !drag.moved) select(null); drag = null; });
  svg.addEventListener('wheel', (e) => {
    e.preventDefault();
    const f = Math.exp(e.deltaY * 0.0015);
    const rect = svg.getBoundingClientRect();
    const mx = view.x + ((e.clientX - rect.left) / rect.width) * view.w, my = view.y + ((e.clientY - rect.top) / rect.height) * view.h;
    view = { x: mx - (mx - view.x) * f, y: my - (my - view.y) * f, w: view.w * f, h: view.h * f }; setView();
  }, { passive: false });

  // --- tables
  const repRows = new Map(), indRows = new Map();
  for (const r of m.reports) {
    const inds = r.indicators.map((k2) => indByKey.get(k2)).filter(Boolean).map((i) => i.label + ': ' + i.value).join('\\n');
    const tr = el('tr', {},
      el('td', { className: 'nowrap', textContent: r.id }), el('td', { className: 'nowrap', textContent: day(r.at) }), el('td', { textContent: r.type }),
      el('td', { textContent: r.reporter ? r.reporter.fullName : (r.purged ? '(изтрити по срок)' : '-') }),
      el('td', { className: 'nowrap', textContent: r.reporter ? r.reporter.phone : '' }), el('td', { textContent: r.reporter ? r.reporter.email : '' }),
      el('td', { className: 'value', textContent: inds }));
    tr.addEventListener('click', () => select('r:' + r.id));
    tr.dataset.text = tr.textContent.toLowerCase();
    $('reports').tBodies[0].append(tr); repRows.set('r:' + r.id, tr);
  }
  for (const i of m.indicators) {
    const tr = el('tr', {},
      el('td', { className: 'nowrap', textContent: (i.seed ? '★ ' : '') + i.label }), el('td', { className: 'value', textContent: i.value }),
      el('td', { textContent: String(i.total) }), el('td', { textContent: String(i.inResult) }), el('td', { textContent: String(i.reporters) }));
    tr.addEventListener('click', () => select('i:' + i.key));
    tr.dataset.text = tr.textContent.toLowerCase();
    $('indicators').tBodies[0].append(tr); indRows.set('i:' + i.key, tr);
  }

  // --- selection: a node, its neighbours, and the reports one step further
  let selected = null;
  function select(id) {
    selected = id && id !== selected ? id : null;
    const keep = new Set();
    if (selected) {
      keep.add(selected);
      for (const a of nodes.get(selected).links) { keep.add(a); for (const b of nodes.get(a).links) if (!b.startsWith('r:') || selected.startsWith('r:')) keep.add(b); }
    }
    for (const n of list) n.g.classList.toggle('dim', Boolean(selected) && !keep.has(n.id));
    for (const line of gEdges.children) line.classList.toggle('dim', Boolean(selected) && !(keep.has(line.dataset.a) && keep.has(line.dataset.b)));
    for (const [nid, tr] of [...repRows, ...indRows]) tr.classList.toggle('sel', Boolean(selected) && keep.has(nid));
    applyFilter();
  }
  function applyFilter() {
    const f = $('filter').value.trim().toLowerCase();
    for (const [nid, tr] of [...repRows, ...indRows]) {
      const bySel = !selected || tr.classList.contains('sel');
      tr.hidden = !(bySel && (!f || tr.dataset.text.includes(f)));
    }
  }
  $('filter').addEventListener('input', applyFilter);
})();
`;
