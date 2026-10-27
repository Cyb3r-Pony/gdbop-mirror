import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleRequest } from '../src/handler.js';
import { extractIndicators, normalizeName, seal, unseal, purgeExpired } from '../src/intel.js';
import { makeD1 } from './d1.mjs';

const ORIGIN = 'https://example.bg';
const egn = (() => {
  const base = '900512123';
  const w = [2, 4, 8, 5, 10, 9, 7, 3, 6];
  return base + ((w.reduce((a, wi, i) => a + wi * Number(base[i]), 0) % 11) % 10);
})();

const body = (over = {}) => ({
  crimeType: 'investment',
  alreadyReported: 'no',
  fullName: 'Иван Петров Георгиев',
  egn,
  phone: '0888123456',
  email: 'ivan@example.com',
  suspect: 'сайт crypto-profit.pro, IBAN BG80 BNBG 9661 1020 3456 78',
  content: 'Платих на https://www.scam-invest.com/pay и повече не ми отговарят. Пишеха от +44 20 7946 0958.',
  consent: true,
  notEmergency: true,
  truthDeclaration: true,
  captchaToken: 'tok',
  ...over,
});

const encKey = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));

const makeEnv = (over = {}) => {
  const sent = [];
  const env = {
    ALLOWED_ORIGINS: ORIGIN,
    PUBLIC_BASE_URL: ORIGIN,
    REPORT_FROM: 'reports@example.bg',
    REPORT_TO: 'inbox@example.org',
    TURNSTILE_SECRET: 's',
    SEND_EMAIL: { send: async (m) => { sent.push(m); } },
    INTEL_ENABLED: 'true',
    INTEL_DB: makeD1(),
    INTEL_HMAC_KEY: 'h'.repeat(40),
    INTEL_ENC_KEY: encKey,
    REPORTER_RETENTION_DAYS: '1825',
    ...over,
  };
  return { env, sent };
};

let clock = new Date('2026-10-26T10:00:00Z');
const deps = (extra = {}) => ({
  EmailMessage: class { constructor(from, to, raw) { Object.assign(this, { from, to, raw }); } },
  fetchFn: async () => new Response(JSON.stringify({ success: true, hostname: 'example.bg' })),
  now: () => clock,
  ...extra,
});

const submit = (env, payload, d = deps()) =>
  handleRequest(
    new Request(`${ORIGIN}/api/report`, {
      method: 'POST',
      headers: { Origin: ORIGIN, 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.9' },
      body: JSON.stringify(payload),
    }),
    env,
    d,
  );

const emailText = (msg) => Buffer.from(msg.raw.split('\r\n\r\n')[1].replace(/\r\n/g, ''), 'base64').toString('utf8');

// --- extraction ------------------------------------------------------------------

test('extracts identifiers of every kind, normalised, without the reporter\'s own phone/email', async () => {
  const found = await extractIndicators([
    'Сайт: crypto-profit.pro и https://www.Scam-Invest.com/login, @invest_guru, +359 888 123 456, 0899 111 222. ' +
      'https://m.facebook.com/profile.php?id=12345 и t.me/FakeBroker. IBAN BG80 BNBG 9661 1020 3456 78 EUR, ' +
      'DE89 3704 0044 0532 0130 00. 1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq ' +
      'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t 0xdAC17F958D2ee523a2206206994597C13D831ec7. support@scam-invest[.]com, ' +
      'ivan@abv.bg, node.js, mvr.bg, hxxps[://]evil[.]xyz/a, 1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNb, BG80BNBG96611020345679',
  ], { exclude: { phone: '+359899111222', email: 'ivan@abv.bg' } });
  const got = found.map((f) => `${f.kind}:${f.value}`).sort();
  assert.deepEqual(got, [
    'crypto:0xdac17f958d2ee523a2206206994597c13d831ec7',
    'crypto:1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa',
    'crypto:TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
    'crypto:bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq',
    'domain:crypto-profit.pro',
    'domain:evil.xyz',
    'domain:scam-invest.com',
    'email:support@scam-invest.com',
    'handle:invest_guru',
    'iban:BG80BNBG96611020345678',
    'iban:DE89370400440532013000',
    'phone:+359888123456',
    'url:facebook.com/profile.php?id=12345',
    'url:t.me/FakeBroker',
  ]);
});

test('a shared platform without a path, and mail providers, are not identifiers', async () => {
  assert.deepEqual(await extractIndicators(['https://facebook.com/ и gmail.com, www.abv.bg/x, example.bg']), []);
});

test('names match across Cyrillic/Latin, case, spacing and hyphens', () => {
  assert.equal(normalizeName('Иван  Петров-Георгиев'), 'IVAN PETROV GEORGIEV');
  assert.equal(normalizeName('ivan PETROV georgiev'), 'IVAN PETROV GEORGIEV');
  assert.equal(normalizeName('Йордан Щерев Юриев'), 'YORDAN SHTEREV YURIEV');
  assert.equal(normalizeName('Мария Георгий Цветанова'), normalizeName('Maria Georgi Tzvetanova'));
  assert.equal(normalizeName('Христо'), normalizeName('Khristo'));
});

test('sealed reporter data opens only with the same key and report id', async () => {
  const key = new Uint8Array(32).fill(1);
  const sealed = await seal(key, 'MVR-GDBOP-20261026-AAAAA', { fullName: 'Иван' });
  assert.deepEqual(await unseal(key, 'MVR-GDBOP-20261026-AAAAA', sealed), { fullName: 'Иван' });
  assert.equal(await unseal(key, 'MVR-GDBOP-20261026-BBBBB', sealed), null);
  assert.equal(await unseal(new Uint8Array(32).fill(2), 'MVR-GDBOP-20261026-AAAAA', sealed), null);
});

// --- report flow -------------------------------------------------------------------

test('off by default: no section in the email, nothing stored', async () => {
  const { env, sent } = makeEnv({ INTEL_ENABLED: 'false' });
  assert.equal((await submit(env, body())).status, 200);
  assert.doesNotMatch(emailText(sent[0]), /ВРЪЗКИ С ДРУГИ СИГНАЛИ/);
  assert.equal(env.INTEL_DB.rows('SELECT * FROM reports').length, 0);
});

test('enabled without valid keys behaves as off', async () => {
  for (const over of [{ INTEL_ENC_KEY: 'short' }, { INTEL_HMAC_KEY: 'too-short' }, { INTEL_DB: undefined }]) {
    const { env, sent } = makeEnv(over);
    assert.equal((await submit(env, body())).status, 200);
    assert.doesNotMatch(emailText(sent[0]), /ВРЪЗКИ С ДРУГИ СИГНАЛИ/);
  }
});

test('stores identifiers and reporter keys; a later report sees the links', async () => {
  const { env, sent } = makeEnv();
  clock = new Date('2026-10-20T08:00:00Z');
  const first = await (await submit(env, body())).json();
  let text = emailText(sent[0]);
  assert.match(text, /== ВРЪЗКИ С ДРУГИ СИГНАЛИ ==/);
  assert.match(text, /Домейн: scam-invest\[\.\]com - не е подаван досега/);
  assert.match(text, /IBAN: BG80BNBG96611020345678 - не е подаван досега/);
  assert.match(text, /Телефон: \+442079460958/);
  assert.match(text, /Подател: няма други сигнали/);

  const db = env.INTEL_DB;
  assert.equal(db.rows('SELECT * FROM reports').length, 1);
  assert.equal(db.rows('SELECT * FROM reporter_keys').length, 3);
  const dump = JSON.stringify([db.rows('SELECT * FROM reporter_keys'), db.rows('SELECT * FROM reporter_data')]);
  for (const secret of ['Иван', 'IVAN', '888123456', 'ivan@example.com']) assert.ok(!dump.includes(secret), secret);

  // another person, same domain; then the first reporter again, different site
  clock = new Date('2026-10-25T08:00:00Z');
  await submit(env, body({ fullName: 'Мария Иванова Петрова', phone: '0899000111', email: 'maria@example.com', suspect: '', content: 'И мен ме измамиха от scam-invest.com/login с обещания за печалба.' }));
  text = emailText(sent[1]);
  assert.match(text, new RegExp(`Домейн: scam-invest\\[\\.\\]com - още 1 сигнал \\(последен 2026-10-20\\): ${first.id}`));
  assert.match(text, /Подател: няма други сигнали/);

  clock = new Date('2026-10-26T08:00:00Z');
  await submit(env, body({ fullName: 'ivan petrov georgiev', suspect: '', content: 'Нов случай, този път през сайта other-scam.online и обаждане.' }));
  text = emailText(sent[2]);
  assert.match(text, new RegExp(`Подател, същите имена: още 1 сигнал: ${first.id}`));
  assert.match(text, new RegExp(`Подател, същия телефон: още 1 сигнал: ${first.id}`));
  assert.match(text, /Домейн: other-scam\[\.\]online - не е подаван досега/);
});

test('a database failure only adds a note; the report is still sent', async () => {
  const { env, sent } = makeEnv({ INTEL_DB: makeD1({ failOn: /./ }) });
  const res = await submit(env, body());
  assert.equal(res.status, 200);
  assert.match(emailText(sent[0]), /Проверката не беше достъпна в момента/);
});

test('nothing is stored when the email could not be sent', async () => {
  const { env } = makeEnv({ SEND_EMAIL: { send: async () => { throw new Error('x'); } } });
  assert.equal((await submit(env, body())).status, 502);
  assert.equal(env.INTEL_DB.rows('SELECT * FROM reports').length, 0);
});

test('retention: old reporter data is deleted, identifiers and reports stay; 0 keeps everything', async () => {
  const { env } = makeEnv({ REPORTER_RETENTION_DAYS: '30' });
  clock = new Date('2026-08-01T08:00:00Z');
  await submit(env, body());
  clock = new Date('2026-10-20T08:00:00Z');
  await submit(env, body({ phone: '0899000111', email: 'other@example.com', fullName: 'Мария Иванова Петрова' }));

  await purgeExpired({ ...env, REPORTER_RETENTION_DAYS: '0' }, new Date('2026-10-26T00:00:00Z'));
  assert.equal(env.INTEL_DB.rows('SELECT * FROM reporter_data').length, 2);

  await purgeExpired(env, new Date('2026-10-26T00:00:00Z'));
  const db = env.INTEL_DB;
  assert.equal(db.rows('SELECT * FROM reports').length, 2);
  assert.equal(db.rows('SELECT * FROM reporter_data').length, 1);
  assert.equal(db.rows('SELECT * FROM reporter_keys').length, 3);
  assert.equal(db.rows('SELECT * FROM reports WHERE reporter_purged_at IS NOT NULL').length, 1);
  assert.ok(db.rows('SELECT * FROM indicators').length >= 3);
  assert.equal(db.rows('SELECT DISTINCT report_id FROM report_indicators').length, 2);
});

test('the public form never reads the database back: the response is only { ok, id }', async () => {
  const { env } = makeEnv();
  await submit(env, body());
  const res = await submit(env, body());
  assert.deepEqual(Object.keys(await res.json()).sort(), ['id', 'ok']);
});
