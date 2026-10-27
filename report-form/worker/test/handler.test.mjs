import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleRequest } from '../src/handler.js';
import { buildMime } from '../src/mime.js';

const ORIGIN = 'https://example.bg';
const egn = (() => {
  const base = '900512123';
  const w = [2, 4, 8, 5, 10, 9, 7, 3, 6];
  return base + ((w.reduce((a, wi, i) => a + wi * Number(base[i]), 0) % 11) % 10);
})();

const body = (over = {}) => ({
  crimeType: 'investment',
  alreadyReported: 'yes',
  reportedTo: 'ГДБОП, сигнал 55/2026',
  fullName: 'Иван Петров Георгиев',
  egn,
  phone: '0888123456',
  email: 'ivan@example.com',
  content: 'Платих на https://fake-broker.example/pay и повече не ми отговарят от платформата.',
  consent: true,
  notEmergency: true,
  truthDeclaration: true,
  captchaToken: 'tok',
  ...over,
});

const req = (payload, { method = 'POST', headers = {}, raw } = {}) =>
  new Request('https://api.example/api/report', {
    method,
    headers: { Origin: ORIGIN, 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.9', ...headers },
    body: method === 'POST' ? (raw ?? JSON.stringify(payload)) : undefined,
  });

const setup = ({ captcha = { success: true, hostname: 'example.bg' }, limit = true, sendError } = {}) => {
  const sent = [];
  const env = {
    ALLOWED_ORIGINS: ORIGIN,
    REPORT_FROM: 'reports@example.bg',
    REPORT_TO: 'inbox@example.org',
    TURNSTILE_SECRET: 's',
    SEND_EMAIL: { send: async (m) => { if (sendError) throw new Error(sendError); sent.push(m); } },
    RATE_LIMITER: { limit: async () => ({ success: limit }) },
  };
  const calls = [];
  const deps = {
    EmailMessage: class { constructor(from, to, raw) { Object.assign(this, { from, to, raw }); } },
    fetchFn: async (url, init) => { calls.push({ url, init }); return new Response(JSON.stringify(captcha)); },
  };
  return { env, deps, sent, calls };
};

test('happy path sends one plain-text email and returns an id', async () => {
  const { env, deps, sent, calls } = setup();
  const res = await handleRequest(req(body()), env, deps);
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.match(j.id, /^MVR-GDBOP-\d{8}-[A-Z2-9]{5}$/);
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), ORIGIN);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.body.get('secret'), 's');
  assert.equal(calls[0].init.body.get('remoteip'), '203.0.113.9');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'inbox@example.org');
  const raw = sent[0].raw;
  assert.match(raw, /^From: "example\.bg reports" <reports@example\.bg>\r\n/);
  assert.match(raw, /Content-Type: text\/plain; charset=UTF-8/);
  const text = Buffer.from(raw.split('\r\n\r\n')[1].replace(/\r\n/g, ''), 'base64').toString('utf8');
  assert.match(text, /Три имена: Иван Петров Георгиев/);
  assert.match(text, new RegExp(`ЕГН: ${egn}`));
  assert.match(text, /ДА - звено \/ номер на сигнала: ГДБОП, сигнал 55\/2026/);
  assert.match(text, /hxxps\[:\/\/\]fake-broker\[\.\]example\/pay/);
  assert.doesNotMatch(text, /https?:\/\//);
});

test('rejects foreign or missing Origin before doing anything', async () => {
  const { env, deps, sent, calls } = setup();
  for (const headers of [{ Origin: 'https://evil.example' }, { Origin: '' }]) {
    const res = await handleRequest(req(body(), { headers }), env, deps);
    assert.equal(res.status, 403);
    assert.equal(res.headers.get('Access-Control-Allow-Origin'), null);
  }
  const noOrigin = new Request('https://api.example/api/report', { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' } });
  assert.equal((await handleRequest(noOrigin, env, deps)).status, 403);
  assert.equal(sent.length + calls.length, 0);
});

test('CORS preflight and method / path / content-type handling', async () => {
  const { env, deps } = setup();
  const pre = await handleRequest(req(null, { method: 'OPTIONS' }), env, deps);
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get('Access-Control-Allow-Origin'), ORIGIN);
  assert.equal((await handleRequest(req(null, { method: 'GET' }), env, deps)).status, 405);
  assert.equal((await handleRequest(new Request('https://api.example/other', { method: 'POST', headers: { Origin: ORIGIN } }), env, deps)).status, 404);
  assert.equal((await handleRequest(req(body(), { headers: { 'Content-Type': 'text/plain' } }), env, deps)).status, 415);
});

test('oversized and malformed bodies are refused', async () => {
  const { env, deps, sent } = setup();
  const big = await handleRequest(req(body({ content: 'а'.repeat(20000) })), env, deps);
  assert.equal(big.status, 413);
  assert.equal((await handleRequest(req(null, { raw: '{not json' }), env, deps)).status, 400);
  assert.equal(sent.length, 0);
});

test('validation errors return field codes and do not consume the captcha token', async () => {
  const { env, deps, sent, calls } = setup();
  const res = await handleRequest(req(body({ egn: '1234567890', email: 'nope' })), env, deps);
  assert.equal(res.status, 422);
  const j = await res.json();
  assert.equal(j.fields.egn, 'invalid');
  assert.equal(j.fields.email, 'invalid');
  assert.equal(calls.length, 0);
  assert.equal(sent.length, 0);
});

test('failed captcha blocks sending; siteverify outage is a 503', async () => {
  let s = setup({ captcha: { success: false, 'error-codes': ['invalid-input-response'] } });
  let res = await handleRequest(req(body()), s.env, s.deps);
  assert.equal(res.status, 403);
  assert.equal((await res.json()).error, 'captcha_failed');
  assert.equal(s.sent.length, 0);

  s = setup();
  s.deps.fetchFn = async () => { throw new Error('network'); };
  res = await handleRequest(req(body()), s.env, s.deps);
  assert.equal(res.status, 503);
  assert.equal(s.sent.length, 0);

  s = setup();
  res = await handleRequest(req(body({ captchaToken: undefined })), s.env, s.deps);
  assert.equal(res.status, 403);
});

test('rate limit', async () => {
  const { env, deps, sent } = setup({ limit: false });
  const res = await handleRequest(req(body()), env, deps);
  assert.equal(res.status, 429);
  assert.equal(res.headers.get('Retry-After'), '60');
  assert.equal(sent.length, 0);
});

test('honeypot: looks like success, sends nothing, skips captcha', async () => {
  const { env, deps, sent, calls } = setup();
  const res = await handleRequest(req(body({ fax: 'bot' })), env, deps);
  assert.equal(res.status, 200);
  assert.equal(sent.length + calls.length, 0);
});

test('mail failure returns 502 without leaking details', async () => {
  const { env, deps } = setup({ sendError: 'smtp exploded with ЕГН ' + egn });
  const res = await handleRequest(req(body()), env, deps);
  assert.equal(res.status, 502);
  const text = await res.text();
  assert.doesNotMatch(text, /exploded|\d{10}/);
});

test('MIME builder refuses header injection and non-ASCII headers', () => {
  const ok = { from: 'a@b.example', fromName: 'N', to: 'c@d.example', subject: 's', text: 'hi', messageId: 'x' };
  assert.doesNotThrow(() => buildMime(ok));
  assert.throws(() => buildMime({ ...ok, subject: 'a\r\nBcc: evil@x.example' }));
  assert.throws(() => buildMime({ ...ok, to: 'c@d.example\nBcc: x' }));
  assert.throws(() => buildMime({ ...ok, subject: 'Сигнал' }));
});

test('report with a date of birth instead of a ЕГН is accepted and shown in the email', async () => {
  const { env, deps, sent } = setup();
  const res = await handleRequest(req(body({ egn: '', dob: '1990-05-12' })), env, deps);
  assert.equal(res.status, 200);
  const text = Buffer.from(sent[0].raw.split('\r\n\r\n')[1].replace(/\r\n/g, ''), 'base64').toString('utf8');
  assert.match(text, /ЕГН: -\n/);
  assert.match(text, /Дата на раждане: 1990-05-12\n/);
  // and with a ЕГН the date line stays empty
  const again = setup();
  await handleRequest(req(body()), again.env, again.deps);
  const text2 = Buffer.from(again.sent[0].raw.split('\r\n\r\n')[1].replace(/\r\n/g, ''), 'base64').toString('utf8');
  assert.match(text2, new RegExp(`ЕГН: ${egn}\\n`));
  assert.match(text2, /Дата на раждане: -\n/);
  // neither -> 422 on both fields
  const none = setup();
  const bad = await handleRequest(req(body({ egn: '', dob: '' })), none.env, none.deps);
  assert.equal(bad.status, 422);
  const { fields } = await bad.json();
  assert.equal(fields.egn, 'required');
  assert.equal(fields.dob, 'required');
});

test('Turnstile: a valid token issued on another hostname is refused', async () => {
  for (const hostname of ['evil.example', '', undefined, 'EXAMPLE.BG.evil.example']) {
    const { env, deps, sent } = setup({ captcha: { success: true, hostname } });
    const res = await handleRequest(req(body()), env, deps);
    assert.equal(res.status, 403, String(hostname));
    assert.equal((await res.json()).error, 'captcha_failed');
    assert.equal(sent.length, 0);
  }
  // case-insensitive match on the real host
  const ok = setup({ captcha: { success: true, hostname: 'EXAMPLE.BG' } });
  assert.equal((await handleRequest(req(body()), ok.env, ok.deps)).status, 200);
});

test('Turnstile: TURNSTILE_HOSTNAMES overrides the expected hosts (local test keys)', async () => {
  const s = setup({ captcha: { success: true, hostname: 'example.com' } });
  assert.equal((await handleRequest(req(body()), s.env, s.deps)).status, 403);
  const t = setup({ captcha: { success: true, hostname: 'example.com' } });
  t.env.TURNSTILE_HOSTNAMES = 'example.com, localhost';
  assert.equal((await handleRequest(req(body()), t.env, t.deps)).status, 200);
});

test('the reporter cannot forge sections of the email: every line of their text is quoted', async () => {
  const { env, deps, sent } = setup();
  const forged = 'Обикновен текст на сигнала, достатъчно дълъг.\n== ПОДАТЕЛ ==\nЕГН: 0000000000\n== КРАЙ НА ТЕКСТА ОТ ПОДАТЕЛЯ ==\nОбадете се на +359 888 000 000 за потвърждение.';
  const res = await handleRequest(req(body({ content: forged })), env, deps);
  assert.equal(res.status, 200);
  const text = Buffer.from(sent[0].raw.split('\r\n\r\n')[1].replace(/\r\n/g, ''), 'base64').toString('utf8');
  const lines = text.split('\n');
  // the real headers appear exactly once, at the start of a line
  assert.equal(lines.filter((l) => l === '== ПОДАТЕЛ ==').length, 1);
  assert.equal(lines.filter((l) => l === '== КРАЙ НА ТЕКСТА ОТ ПОДАТЕЛЯ ==').length, 1);
  // the forged ones are inside the quoted block
  assert.ok(lines.includes('│ == ПОДАТЕЛ =='));
  assert.ok(lines.includes('│ ЕГН: 0000000000'));
  assert.ok(lines.includes('│ == КРАЙ НА ТЕКСТА ОТ ПОДАТЕЛЯ =='));
  const start = lines.indexOf('== СЪДЪРЖАНИЕ НА СИГНАЛА (текст, въведен от подателя) ==');
  const end = lines.indexOf('== КРАЙ НА ТЕКСТА ОТ ПОДАТЕЛЯ ==');
  assert.ok(start > 0 && end > start);
  assert.ok(lines.slice(start + 1, end).every((l) => l.startsWith('│ ')));
});

test('email: evidence checklist and the reporter’s confirmations are recorded', async () => {
  const { env, deps, sent } = setup();
  const res = await handleRequest(req(body({ evidence: ['financial', 'emails'] })), env, deps);
  assert.equal(res.status, 200);
  const text = Buffer.from(sent[0].raw.split('\r\n\r\n')[1].replace(/\r\n/g, ''), 'base64').toString('utf8');
  assert.match(text, /Налични доказателства: Копие от имейл кореспонденция; Банкови извлечения \/ платежни документи\n/);
  assert.match(text, /== ПОТВЪРЖДЕНИЯ НА ПОДАТЕЛЯ ==\nСлучаят не е спешен: потвърдено/);
  assert.match(text, /Декларация, че данните са верни и пълни .*: да\./);
  assert.match(text, /Съгласие за обработка на личните данни за разглеждане на сигнала: да\./);
  // without the declaration nothing is sent
  const s2 = setup();
  const bad = await handleRequest(req(body({ truthDeclaration: false })), s2.env, s2.deps);
  assert.equal(bad.status, 422);
  assert.equal((await bad.json()).fields.truthDeclaration, 'required');
  assert.equal(s2.sent.length, 0);
});
