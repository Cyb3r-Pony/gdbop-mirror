import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { handleRequest } from '../src/handler.js';
import { runSearch, renderTables, renderCsv, renderHtml, lit, UserError } from '../scripts/intel-lib.mjs';
import { makeD1 } from './d1.mjs';

const ORIGIN = 'https://example.bg';
const ENC = new Uint8Array(32).fill(7);
const HMAC = 'h'.repeat(40);
const egn = (() => {
  const base = '900512123';
  const w = [2, 4, 8, 5, 10, 9, 7, 3, 6];
  return base + ((w.reduce((a, wi, i) => a + wi * Number(base[i]), 0) % 11) % 10);
})();

const body = (over = {}) => ({
  crimeType: 'investment', alreadyReported: 'no', fullName: 'Иван Петров Георгиев', egn, phone: '0888123456',
  email: 'ivan@example.com', suspect: 'сайт crypto-profit.pro, IBAN BG80 BNBG 9661 1020 3456 78',
  content: 'Платих на https://www.scam-invest.com/pay и повече не ми отговарят от платформата.',
  consent: true, notEmergency: true, truthDeclaration: true, captchaToken: 'tok', ...over,
});

// Three reports: A and B share scam-invest.com; C shares only the IBAN with A; D is old (past retention).
const seeded = async ({ retention = '30' } = {}) => {
  const db = makeD1();
  const env = {
    ALLOWED_ORIGINS: ORIGIN, PUBLIC_BASE_URL: ORIGIN, REPORT_FROM: 'r@example.bg', REPORT_TO: 'i@example.org', TURNSTILE_SECRET: 's',
    SEND_EMAIL: { send: async () => {} }, INTEL_ENABLED: 'true', INTEL_DB: db, INTEL_HMAC_KEY: HMAC,
    INTEL_ENC_KEY: Buffer.from(ENC).toString('base64'), REPORTER_RETENTION_DAYS: retention,
  };
  const at = (iso, payload) => handleRequest(
    new Request(`${ORIGIN}/api/report`, { method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }),
    env,
    {
      EmailMessage: class { constructor(f, t, r) { Object.assign(this, { f, t, r }); } },
      fetchFn: async () => new Response(JSON.stringify({ success: true, hostname: 'example.bg' })),
      now: () => new Date(iso),
    },
  ).then((r) => r.json()).then((j) => j.id);
  const D = await at('2026-08-01T08:00:00Z', body({ suspect: '', content: 'Стар случай с old-scam.com/login и много обещания за печалба.' }));
  const A = await at('2026-10-20T08:00:00Z', body());
  const B = await at('2026-10-22T08:00:00Z', body({ fullName: 'Мария Иванова Петрова', phone: '0899000111', email: 'maria@example.com', suspect: '', content: "И мен ме измамиха от scam-invest.com/login и t.me/Fake'Broker;x с обещания." }));
  const C = await at('2026-10-24T08:00:00Z', body({ fullName: 'Петър Петров Петров', phone: '0877555666', email: 'petar@example.com', suspect: 'BG80BNBG96611020345678', content: 'Преведох пари по сметка, която ми дадоха по телефона, без сайт.' }));
  return { db, ids: { A, B, C, D }, exec: (sql) => db.rows(sql) };
};

const opts = (over) => ({ depth: 1, days: 30, encKey: ENC, hmacSecret: HMAC, retentionDays: 30, now: new Date('2026-10-26T10:00:00Z'), who: 'tester@host', ...over });

test('find: a pasted, defanged URL finds its reports with the reporters opened locally', async () => {
  const { exec, ids } = await seeded();
  const m = await runSearch(exec, opts({ kind: 'find', q: 'hxxps[://]www.scam-invest[.]com/anything' }));
  assert.deepEqual(m.reports.map((r) => r.id), [ids.B, ids.A]);
  assert.equal(m.reports[1].reporter.fullName, 'Иван Петров Георгиев');
  const dom = m.indicators.find((i) => i.value === 'scam-invest.com');
  assert.equal(dom.seed, true);
  assert.equal(dom.total, 2);
  assert.equal(dom.reporters, 2);
  const text = renderTables(m);
  assert.match(text, /Мария Иванова Петрова/);
  assert.match(text, /\* Домейн\s+scam-invest\.com/);
});

test('depth 2 follows shared identifiers: the IBAN brings in a report without the site', async () => {
  const { exec, ids } = await seeded();
  const one = await runSearch(exec, opts({ kind: 'find', q: 'scam-invest.com' }));
  assert.ok(!one.reports.some((r) => r.id === ids.C));
  const two = await runSearch(exec, opts({ kind: 'find', q: 'scam-invest.com', depth: 2 }));
  assert.deepEqual(two.reports.map((r) => r.id).sort(), [ids.A, ids.B, ids.C].sort());
});

test('reporter search by phone, name (Latin) and email; report search; top', async () => {
  const { exec, ids } = await seeded();
  assert.deepEqual((await runSearch(exec, opts({ kind: 'phone', q: '+359 888 123 456', depth: 1 }))).reports.map((r) => r.id), [ids.A]);
  assert.deepEqual((await runSearch(exec, opts({ kind: 'name', q: 'maria ivanova petrova', depth: 1 }))).reports.map((r) => r.id), [ids.B]);
  assert.deepEqual((await runSearch(exec, opts({ kind: 'email', q: 'PETAR@example.com', depth: 1 }))).reports.map((r) => r.id), [ids.C]);
  const rep = await runSearch(exec, opts({ kind: 'report', q: ids.C.toLowerCase(), depth: 2 }));
  assert.deepEqual(rep.reports.map((r) => r.id).sort(), [ids.A, ids.C].sort());
  const top = await runSearch(exec, opts({ kind: 'top' }));
  assert.deepEqual(top.indicators.filter((i) => i.seed).map((i) => i.value).sort(), ['BG80BNBG96611020345678', 'scam-invest.com']);
});

test('reporter data past retention is neither shown nor matched', async () => {
  const { exec, ids } = await seeded();
  const m = await runSearch(exec, opts({ kind: 'report', q: ids.D, depth: 1 }));
  assert.equal(m.reports[0].reporter, null);
  assert.equal(m.reports[0].purged, true);
  // the phone also belongs to A (in term) and D (expired): only A comes back
  assert.deepEqual((await runSearch(exec, opts({ kind: 'phone', q: '0888123456', depth: 1 }))).reports.map((r) => r.id), [ids.A]);
});

test('a wrong key is reported, not silently "no results"', async () => {
  const { exec, ids } = await seeded();
  await assert.rejects(runSearch(exec, opts({ kind: 'phone', q: '0888123456', hmacSecret: 'x'.repeat(40) })), (e) => e instanceof UserError && /HMAC/.test(e.message));
  await assert.rejects(runSearch(exec, opts({ kind: 'report', q: ids.A, encKey: new Uint8Array(32).fill(9) })), (e) => e instanceof UserError && /INTEL_ENC_KEY/.test(e.message));
  await assert.rejects(runSearch(exec, opts({ kind: 'report', q: "x'; DROP TABLE reports; --" })), UserError);
  await assert.rejects(runSearch(exec, opts({ kind: 'phone', q: 'abc' })), UserError);
});

test('SQL in a search or in a stored value never leaves its literal', async () => {
  const { exec, db } = await seeded();
  assert.match(lit("a'; DROP TABLE reports; --"), /^CAST\(X'[0-9a-f]+' AS TEXT\)$/);
  for (const q of ["' OR 1=1 --", 'x%" UNION SELECT sealed FROM reporter_data --', "Fake'Broker;x", '%']) {
    await runSearch(exec, opts({ kind: 'find', q, depth: 3 }));
  }
  await runSearch(exec, opts({ kind: 'name', q: 'Robert Drop Tables' }));
  // the stored t.me path with a quote and a semicolon is followed at depth 2 like any other value
  const m = await runSearch(exec, opts({ kind: 'find', q: "t.me/Fake'Broker;x", depth: 2 }));
  assert.ok(m.indicators.some((i) => i.value === "t.me/Fake'Broker;x" && i.seed));
  assert.equal(db.rows('SELECT COUNT(*) AS n FROM reports')[0].n, 4);
});

test('every search is logged; reporter searches only by HMAC', async () => {
  const { exec, db } = await seeded();
  await runSearch(exec, opts({ kind: 'find', q: 'scam-invest.com' }));
  await runSearch(exec, opts({ kind: 'phone', q: '0888123456' }));
  const log = db.rows('SELECT who, action, query FROM audit_log ORDER BY id');
  assert.deepEqual(log.map((l) => l.action), ['find', 'phone']);
  assert.equal(log[0].query, 'scam-invest.com');
  assert.match(log[1].query, /^hmac:/);
  assert.ok(log.every((l) => l.who === 'tester@host'));
});

test('CSV: one row per report and identifier, UTF-8 BOM, formulas neutralised', async () => {
  const { exec } = await seeded();
  const csv = renderCsv(await runSearch(exec, opts({ kind: 'find', q: 'scam-invest.com' })));
  assert.ok(csv.startsWith('﻿report_id,date,crime_type,reporter_name'));
  assert.match(csv, /Иван Петров Георгиев,'\+359888123456,ivan@example\.com,Домейн,scam-invest\.com,2/);
  assert.match(csv, /"t\.me\/Fake'Broker;x"/);
});

test('HTML: offline, CSP hashes match the inline code, report data cannot close the script tag', async () => {
  const { exec } = await seeded();
  const m = await runSearch(exec, opts({ kind: 'find', q: 'scam-invest.com' }));
  m.reports[0].reporter.fullName = '</script><script>alert(1)</script>';
  const html = renderHtml(m);
  const csp = html.match(/Content-Security-Policy" content="([^"]+)"/)[1];
  assert.match(csp, /default-src 'none'/);
  const sha = (s) => createHash('sha256').update(s, 'utf8').digest('base64');
  const css = html.match(/<style>([\s\S]*?)<\/style>/)[1];
  const js = html.match(/<script>([\s\S]*?)<\/script>\s*<\/body>/)[1];
  assert.ok(csp.includes(`'sha256-${sha(css)}'`));
  assert.ok(csp.includes(`'sha256-${sha(js)}'`));
  assert.equal((html.match(/<\/script>/g) || []).length, 2);
  assert.doesNotMatch(html.replace('http://www.w3.org/2000/svg', ''), /https?:\/\//);
});
