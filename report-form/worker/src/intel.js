// Links between reports ("intel"), stored in Cloudflare D1 (binding INTEL_DB).
//
// Off unless INTEL_ENABLED = "true" AND the INTEL_DB binding AND both keys are
// present. Every failure here is non-fatal: the report email is still sent.
//
// What is kept, and for how long:
// - perpetrator identifiers (domains, profile links, emails, phones, IBANs,
//   crypto addresses, @handles) found in the "suspect" and "content" fields,
//   linked to the report number: no time limit;
// - the reporter's name, phone and email: REPORTER_RETENTION_DAYS (0 = no
//   limit), as HMAC-SHA256 (INTEL_HMAC_KEY) for matching plus one AES-256-GCM
//   (INTEL_ENC_KEY) sealed copy, readable only with the key (scripts/intel.mjs);
// - never the report text: the email stays the record of the report.
import { scanText, normalizePhone, validEmail } from './validate.js';

const enc = new TextEncoder();
const dec = new TextDecoder();
const DAY_MS = 24 * 3600 * 1000;
export const DEFAULT_RETENTION_DAYS = 1825;
const MAX_INDICATORS = 30;

export const KIND_LABELS = {
  domain: 'Домейн',
  url: 'Профил / линк',
  email: 'Имейл',
  phone: 'Телефон',
  iban: 'IBAN',
  crypto: 'Крипто адрес',
  handle: 'Потребителско име',
};

export const b64url = (buf) =>
  btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export const fromB64url = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

// --- configuration -----------------------------------------------------------

export const retentionDays = (env) => {
  const n = Number(env.REPORTER_RETENTION_DAYS);
  return env.REPORTER_RETENTION_DAYS !== undefined && env.REPORTER_RETENTION_DAYS !== '' && Number.isSafeInteger(n) && n >= 0
    ? n
    : DEFAULT_RETENTION_DAYS;
};

// Reporter data received before this instant is expired; null = no limit.
export const retentionCutoff = (env, now) => {
  const days = retentionDays(env);
  return days > 0 ? new Date(now.getTime() - days * DAY_MS).toISOString() : null;
};

const decodeEncKey = (s) => {
  try {
    const bytes = fromB64url(String(s || '').trim().replace(/=+$/, ''));
    return bytes.length === 32 ? bytes : null;
  } catch {
    return null;
  }
};

// { db, hmacSecret, encKey, env } when the feature is on and fully configured, else null.
export const intelConfig = (env) => {
  if (env.INTEL_ENABLED !== 'true' || !env.INTEL_DB) return null;
  const encKey = decodeEncKey(env.INTEL_ENC_KEY);
  if (!encKey || typeof env.INTEL_HMAC_KEY !== 'string' || env.INTEL_HMAC_KEY.length < 32) {
    console.error('intel misconfigured');
    return null;
  }
  return { db: env.INTEL_DB, hmacSecret: env.INTEL_HMAC_KEY, encKey, env };
};

// --- reporter: normalisation, HMAC, sealing ----------------------------------

const TRANSLIT = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm',
  н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sht',
  ъ: 'a', ь: 'y', ю: 'yu', я: 'ya', ѝ: 'i', ё: 'yo', э: 'e', ы: 'y', і: 'i', ї: 'yi', є: 'ye', ґ: 'g',
};

// "Иван  Петров-Иванов" and "Ivan Petrov Ivanov" both become "IVAN PETROV IVANOV"
// (Bulgarian official transliteration, diacritics and punctuation dropped), and
// common Latin spellings are folded together: Мария/Maria/Mariya, Георгий/Georgi,
// Цветан/Tzvetan, Христо/Khristo.
export const normalizeName = (s) =>
  [...String(s || '').normalize('NFC').toLowerCase()]
    .map((c) => TRANSLIT[c] ?? c)
    .join('')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/[^a-z]+/g, ' ')
    .replace(/iya/g, 'ia')
    .replace(/iy\b/g, 'i')
    .replace(/tz/g, 'ts')
    .replace(/kh/g, 'h')
    .trim()
    .toUpperCase();

export const normalizeReporter = (kind, value) => {
  const s = String(value || '');
  if (kind === 'name') return normalizeName(s);
  if (kind === 'phone') return normalizePhone(s);
  if (kind === 'email') {
    const e = s.trim().toLowerCase();
    return validEmail(e) ? e : '';
  }
  return '';
};

const hmacKey = (secret) => crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);

// kind -> base64url HMAC, for each non-empty normalised value.
export const reporterMacs = async (secret, values) => {
  const key = await hmacKey(secret);
  const out = {};
  for (const [kind, raw] of Object.entries(values)) {
    const value = normalizeReporter(kind, raw);
    if (value) out[kind] = b64url(await crypto.subtle.sign('HMAC', key, enc.encode(`${kind}\n${value}`)));
  }
  return out;
};

const aesKey = (bytes) => crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']);

// The report id is authenticated data: a sealed row copied onto another report does not open.
export const seal = async (keyBytes, id, obj) => {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(id) }, await aesKey(keyBytes), enc.encode(JSON.stringify(obj)));
  return `v1.${b64url(iv)}.${b64url(ct)}`;
};

export const unseal = async (keyBytes, id, sealed) => {
  try {
    const [v, iv, ct] = String(sealed).split('.');
    if (v !== 'v1') return null;
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64url(iv), additionalData: enc.encode(id) }, await aesKey(keyBytes), fromB64url(ct));
    return JSON.parse(dec.decode(pt));
  } catch {
    return null;
  }
};

// --- indicator extraction ------------------------------------------------------

// Platforms many unrelated people use: the domain alone would link unrelated
// reports, so the profile/page path is kept instead (and a bare host is dropped).
const SHARED_HOSTS = new Set([
  'facebook.com', 'fb.com', 'instagram.com', 't.me', 'telegram.me', 'wa.me', 'whatsapp.com', 'youtube.com', 'youtu.be',
  'tiktok.com', 'x.com', 'twitter.com', 'linkedin.com', 'vk.com', 'olx.bg', 'bazar.bg', 'google.com', 'docs.google.com',
  'drive.google.com', 'sites.google.com', 'forms.gle', 'play.google.com', 'apps.apple.com', 'github.com', 'discord.gg',
  'discord.com', 'viber.com', 'invite.viber.com', 'linktr.ee', 'bit.ly', 'tinyurl.com', 't.co', 'goo.gl', 'is.gd',
  'cutt.ly', 'rb.gy', 'ow.ly', 't.ly', 'shorturl.at', 'tiny.cc',
]);
// Mentioned in passing (mail providers, this service, the police): never an indicator.
const IGNORED_DOMAINS = [
  'example.bg', 'mvr.bg', 'gdbop.bg', 'gmail.com', 'googlemail.com', 'abv.bg', 'mail.bg', 'dir.bg', 'yahoo.com',
  'outlook.com', 'hotmail.com', 'live.com', 'icloud.com', 'me.com', 'proton.me', 'protonmail.com',
];
const ignoredDomain = (host) => IGNORED_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`));

// Bare "word.tld" tokens count as domains only for these TLDs ("node.js" does not).
const BARE_TLDS = new Set([
  'com', 'net', 'org', 'info', 'biz', 'io', 'co', 'bg', 'eu', 'uk', 'de', 'ru', 'ua', 'ro', 'gr', 'tr', 'us', 'me', 'app',
  'online', 'site', 'store', 'shop', 'xyz', 'top', 'live', 'pro', 'club', 'vip', 'cc', 'tv', 'ws', 'ai', 'cloud', 'tech',
  'ltd', 'group', 'finance', 'capital', 'trade', 'trading', 'investments', 'exchange', 'money', 'bank', 'click', 'link',
  'icu', 'cyou', 'sbs', 'bond', 'buzz', 'fun', 'space', 'website', 'digital', 'global', 'world', 'ch', 'at', 'nl', 'pl',
  'cz', 'it', 'es', 'fr', 'cy', 'mt', 'ae', 'hk', 'sg', 'in', 'ca', 'au', 'cn', 'to', 'gg', 'im', 'li', 'lt', 'lv', 'ee',
]);
const BARE_DOMAIN = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+([a-z]{2,24})$/i;

export const refang = (s) =>
  String(s || '')
    .replace(/\[\.\]|\(\.\)|\{\.\}|\[dot\]/gi, '.')
    .replace(/\[:\/\/\]/g, '://')
    .replace(/\[:\]/g, ':')
    .replace(/\[@\]/g, '@')
    .replace(/\bhxxp(s?)/gi, 'http$1')
    .replace(/\bfxp\b/gi, 'ftp');

const hostKey = (host) => host.toLowerCase().replace(/\.$/, '').replace(/^(?:www|m|mobile|web)\./, '');

export const urlIndicator = (raw) => {
  let u;
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`);
  } catch {
    return null;
  }
  const host = hostKey(u.hostname);
  if (!host.includes('.') && !host.startsWith('[')) return null;
  if (SHARED_HOSTS.has(host)) {
    let path = u.pathname.replace(/\/+$/, '');
    if (path === '/profile.php' && u.searchParams.get('id')) path += `?id=${u.searchParams.get('id')}`;
    if (path === '/watch' && u.searchParams.get('v')) path += `?v=${u.searchParams.get('v')}`;
    return path ? { kind: 'url', value: `${host}${path}` } : null;
  }
  return ignoredDomain(host) ? null : { kind: 'domain', value: host };
};

const IBAN_LENGTHS = {
  AD: 24, AE: 23, AL: 28, AT: 20, AZ: 28, BA: 20, BE: 16, BG: 22, BH: 22, BR: 29, CH: 21, CY: 28, CZ: 24, DE: 22,
  DK: 18, EE: 20, ES: 24, FI: 18, FO: 18, FR: 27, GB: 22, GE: 22, GI: 23, GL: 18, GR: 27, HR: 21, HU: 28, IE: 22,
  IL: 23, IS: 26, IT: 27, JO: 30, KW: 30, KZ: 20, LB: 28, LI: 21, LT: 20, LU: 20, LV: 21, MC: 27, MD: 24, ME: 22,
  MK: 19, MT: 31, MU: 30, NL: 18, NO: 15, PK: 24, PL: 28, PS: 29, PT: 25, QA: 29, RO: 24, RS: 22, SA: 24, SE: 24,
  SI: 19, SK: 24, SM: 27, TN: 24, TR: 26, UA: 29, VG: 24, XK: 20,
};
const ibanChecksumOk = (iban) => {
  let rem = 0;
  for (const ch of iban.slice(4) + iban.slice(0, 4)) {
    const digits = ch >= 'A' && ch <= 'Z' ? String(ch.charCodeAt(0) - 55) : ch;
    for (const d of digits) rem = (rem * 10 + Number(d)) % 97;
  }
  return rem === 1;
};
const IBAN_RE = /(?<![A-Za-z0-9])[A-Za-z]{2}\d{2}(?:[ -]?[A-Za-z0-9]){10,30}/g;
// [{ iban, start, end }]: the span covers only the IBAN's own characters, so the
// caller can blank it before looking for phone numbers inside it.
const findIbans = (text) => {
  const out = [];
  for (const m of text.matchAll(IBAN_RE)) {
    const compact = m[0].replace(/[ -]/g, '').toUpperCase();
    const len = IBAN_LENGTHS[compact.slice(0, 2)];
    if (!len || compact.length < len || !ibanChecksumOk(compact.slice(0, len))) continue;
    let end = m.index;
    for (let n = 0; n < len; end += 1) if (/[A-Za-z0-9]/.test(text[end])) n += 1;
    out.push({ iban: compact.slice(0, len), start: m.index, end });
  }
  return out;
};

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const b58decode = (s) => {
  let n = 0n;
  for (const c of s) {
    const i = B58.indexOf(c);
    if (i < 0) return null;
    n = n * 58n + BigInt(i);
  }
  const bytes = [];
  while (n > 0n) { bytes.unshift(Number(n & 0xffn)); n >>= 8n; }
  for (const c of s) { if (c !== '1') break; bytes.unshift(0); }
  return Uint8Array.from(bytes);
};
const sha256 = async (b) => new Uint8Array(await crypto.subtle.digest('SHA-256', b));
// Version bytes: Bitcoin P2PKH/P2SH, Litecoin L/M, Dogecoin, Tron.
const B58_VERSIONS = new Set([0x00, 0x05, 0x30, 0x32, 0x1e, 0x41]);
const base58checkOk = async (s) => {
  const b = b58decode(s);
  if (!b || b.length !== 25 || !B58_VERSIONS.has(b[0])) return false;
  const h = await sha256(await sha256(b.slice(0, 21)));
  return h.slice(0, 4).every((x, i) => x === b[21 + i]);
};
const BECH32 = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const bech32Ok = (addr) => {
  const s = addr.toLowerCase();
  const pos = s.lastIndexOf('1');
  const hrp = s.slice(0, pos);
  const data = [...s.slice(pos + 1)].map((c) => BECH32.indexOf(c));
  if (data.length < 7 || data.some((d) => d < 0)) return false;
  const G = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of [...[...hrp].map((c) => c.charCodeAt(0) >> 5), 0, ...[...hrp].map((c) => c.charCodeAt(0) & 31), ...data]) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i += 1) if ((top >>> i) & 1) chk ^= G[i];
  }
  chk >>>= 0;
  return chk === 1 || chk === 0x2bc830a3; // bech32 / bech32m
};
const EVM_RE = /(?<![0-9A-Za-z])0x[0-9a-fA-F]{40}(?![0-9A-Za-z])/g;
const B58_RE = /(?<![0-9A-Za-z])[13LMDT][1-9A-HJ-NP-Za-km-z]{25,34}(?![0-9A-Za-z])/g;
const BECH32_RE = /(?<![0-9A-Za-z])(?:bc|ltc)1[02-9ac-hj-np-z]{6,87}(?![0-9A-Za-z])/gi;

const BG_PHONE_RE = /(?<![\w+])(?:\+359|00359|0)[ ]?8[7-9](?:[ .-]?\d){7}(?!\d)/g;
const INTL_PHONE_RE = /(?<![\w+])(?:\+|00)[1-9](?:[ .-]?\d){7,14}(?!\d)/g;
const EMAIL_FIND_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,24}/g;
const HANDLE_RE = /(?<![\w@.])@([A-Za-z0-9_][A-Za-z0-9_.]{2,31})(?![\w@])/g;
const TOKEN_TRIM = /^[(\["'«„<]+|[.,;:!?)\]}"'»“>]+$/g;

// Perpetrator identifiers in the free text. `exclude` holds the reporter's own
// phone and email so they are never recorded as a perpetrator's.
export const extractIndicators = async (texts, { exclude = {} } = {}) => {
  const text = refang(texts.filter(Boolean).join('\n'));
  const found = [];
  const add = (kind, value) => {
    if (value && !found.some((f) => f.kind === kind && f.value === value)) found.push({ kind, value });
  };

  for (const u of scanText(text).urls) {
    const ind = urlIndicator(u.url);
    if (ind) add(ind.kind, ind.value);
  }
  for (const token of text.split(/\s+/)) {
    const t = token.replace(TOKEN_TRIM, '');
    const m = t.match(BARE_DOMAIN);
    if (m && !t.includes('@') && BARE_TLDS.has(m[1].toLowerCase())) {
      const ind = urlIndicator(t);
      if (ind) add(ind.kind, ind.value);
    }
  }
  for (const [e] of text.matchAll(EMAIL_FIND_RE)) {
    const email = e.toLowerCase();
    if (validEmail(email) && email !== exclude.email) add('email', email);
  }
  const blank = (str, re) => str.replace(re, (x) => ' '.repeat(x.length));
  const ibans = findIbans(text);
  // IBAN and crypto digits must not be read as phone numbers
  let rest = ibans.reduce((str, { start, end }) => str.slice(0, start) + ' '.repeat(end - start) + str.slice(end), text);
  rest = blank(blank(blank(rest, EVM_RE), BECH32_RE), B58_RE);
  for (const re of [BG_PHONE_RE, INTL_PHONE_RE]) {
    for (const m of rest.matchAll(re)) {
      const phone = normalizePhone(m[0]);
      if (phone && phone !== exclude.phone) add('phone', phone);
    }
    rest = blank(rest, re); // a BG number is not read again as an international one
  }
  for (const { iban } of ibans) add('iban', iban);
  for (const [a] of text.matchAll(EVM_RE)) add('crypto', a.toLowerCase());
  for (const [a] of text.matchAll(BECH32_RE)) if (bech32Ok(a)) add('crypto', a.toLowerCase());
  // base58 decoding is the costly check: at most 20 candidates per report (CPU budget)
  let b58 = 0;
  for (const [a] of text.matchAll(B58_RE)) {
    if ((b58 += 1) > 20) break;
    if (await base58checkOk(a)) add('crypto', a);
  }
  for (const m of text.matchAll(HANDLE_RE)) add('handle', m[1].toLowerCase().replace(/\.+$/, ''));

  return found.slice(0, MAX_INDICATORS);
};

// --- storage -------------------------------------------------------------------

const orClauses = (n, clause) => Array.from({ length: n }, () => `(${clause})`).join(' OR ');

// Earlier reports sharing an identifier or the reporter's name/phone/email, for the email.
// { indicators: [{ kind, value, total, reports: [{ id, at }] }], reporter: { kind: { total, reports } } }
export const findLinks = async (cfg, { indicators, macs, now }) => {
  const { db } = cfg;
  const out = {
    indicators: indicators.map((i) => ({ ...i, total: 0, reports: [] })),
    reporter: {},
  };
  const sample = 5;
  if (indicators.length) {
    const where = orClauses(indicators.length, 'i.kind = ? AND i.value = ?');
    const args = indicators.flatMap((i) => [i.kind, i.value]);
    const { results: counts } = await db
      .prepare(`SELECT i.kind, i.value, COUNT(*) AS total FROM indicators i JOIN report_indicators ri ON ri.indicator_id = i.id WHERE ${where} GROUP BY i.id`)
      .bind(...args)
      .all();
    const { results: rows } = await db
      .prepare(
        `SELECT i.kind, i.value, r.id, r.received_at FROM indicators i JOIN report_indicators ri ON ri.indicator_id = i.id
         JOIN reports r ON r.id = ri.report_id WHERE ${where} ORDER BY r.received_at DESC LIMIT 300`,
      )
      .bind(...args)
      .all();
    for (const ind of out.indicators) {
      ind.total = counts.find((c) => c.kind === ind.kind && c.value === ind.value)?.total ?? 0;
      ind.reports = rows.filter((r) => r.kind === ind.kind && r.value === ind.value).slice(0, sample).map((r) => ({ id: r.id, at: r.received_at }));
    }
  }
  const kinds = Object.keys(macs);
  if (kinds.length) {
    const cutoff = retentionCutoff(cfg.env, now);
    const { results } = await db
      .prepare(
        `SELECT k.kind, r.id, r.received_at FROM reporter_keys k JOIN reports r ON r.id = k.report_id
         WHERE (${orClauses(kinds.length, 'k.kind = ? AND k.mac = ?')})${cutoff ? ' AND r.received_at >= ?' : ''}
         ORDER BY r.received_at DESC`,
      )
      .bind(...kinds.flatMap((k) => [k, macs[k]]), ...(cutoff ? [cutoff] : []))
      .all();
    for (const kind of kinds) {
      const mine = results.filter((r) => r.kind === kind);
      out.reporter[kind] = { total: mine.length, reports: mine.slice(0, sample).map((r) => ({ id: r.id, at: r.received_at })) };
    }
  }
  return out;
};

// One transaction: the report, the reporter's keys and sealed data, and the identifiers.
export const storeReport = async (cfg, { id, receivedAt, crimeType, indicators, macs, reporter }) => {
  const { db } = cfg;
  const stmts = [
    db.prepare('INSERT INTO reports (id, received_at, crime_type) VALUES (?, ?, ?)').bind(id, receivedAt.toISOString(), crimeType),
    db.prepare('INSERT INTO reporter_data (report_id, sealed) VALUES (?, ?)').bind(id, await seal(cfg.encKey, id, reporter)),
    ...Object.entries(macs).map(([kind, mac]) => db.prepare('INSERT INTO reporter_keys (report_id, kind, mac) VALUES (?, ?, ?)').bind(id, kind, mac)),
  ];
  for (const { kind, value } of indicators) {
    stmts.push(db.prepare('INSERT INTO indicators (kind, value) VALUES (?, ?) ON CONFLICT (kind, value) DO NOTHING').bind(kind, value));
    stmts.push(
      db.prepare('INSERT OR IGNORE INTO report_indicators (report_id, indicator_id) SELECT ?, id FROM indicators WHERE kind = ? AND value = ?').bind(id, kind, value),
    );
  }
  await db.batch(stmts);
};

// Daily (Cron Trigger): deletes the reporter's data and the search log older than
// REPORTER_RETENTION_DAYS; reports and identifiers stay. Runs whenever the
// database is bound, even with INTEL_ENABLED off, so data never outlives its term.
export const purgeExpired = async (env, now = new Date()) => {
  const db = env.INTEL_DB;
  const cutoff = retentionCutoff(env, now);
  if (!db || !cutoff) return;
  const old = 'SELECT id FROM reports WHERE received_at < ?';
  await db.batch([
    db.prepare(`DELETE FROM reporter_keys WHERE report_id IN (${old})`).bind(cutoff),
    db.prepare(`DELETE FROM reporter_data WHERE report_id IN (${old})`).bind(cutoff),
    db.prepare('UPDATE reports SET reporter_purged_at = ? WHERE received_at < ? AND reporter_purged_at IS NULL').bind(now.toISOString(), cutoff),
    db.prepare('DELETE FROM audit_log WHERE at < ?').bind(cutoff),
  ]);
};
