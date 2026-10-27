// Request handling. Kept free of Worker-only imports so it can be unit-tested
// in plain Node; index.js injects `EmailMessage`.
//
//   POST /api/report               the report (JSON) + a manifest of the files to come
//   PUT  /api/upload/<id>/<name>   one file, streamed straight into R2 quarantine/
//   POST /api/finalize/<id>        all files are up: send the report email, start the scan
//   POST /api/scan-result          the GitHub Action finished a report: send the scan email
//   GET  /api/file/<id>/<name>     signed download of a scanned file (behind Cloudflare Access)
//
// A report without files is sent at once by /api/report. With files, the
// validated report waits in pending/<id>.json until the browser calls
// /api/finalize (or, if the tab was closed, the Cron Trigger sends it after an
// hour with whatever arrived), so the email can say which files really came in.
//
// Order of checks in /api/report is deliberate: cheap and anonymous-safe first
// (origin, method, size, rate limit), then validation, and only then the
// single-use Turnstile token, so a typo in the form doesn't burn the captcha.
import { LIMITS } from './schema.js';
import {
  FILE_TYPES, FILE_LIMITS, REPORT_ID_RE, FILE_NAME_RE, keyFor, extOf, detectFileType, matchesKind, checkManifest,
} from './files.js';
import { validateReport } from './validate.js';
import { buildReportEmail, buildScanEmail, newReportId } from './format.js';
import { buildMime } from './mime.js';
import { sign, verify, signFile, verifyFile, safeEqual, LINK_TTL_SECONDS, UPLOAD_TTL_SECONDS } from './sign.js';
import { intelConfig, extractIndicators, reporterMacs, findLinks, storeReport } from './intel.js';

const TURNSTILE_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

const json = (status, body, headers = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...headers,
    },
  });

const allowedOrigins = (env) =>
  (env.ALLOWED_ORIGINS || 'https://example.bg').split(',').map((s) => s.trim()).filter(Boolean);
const baseUrl = (env) => (env.PUBLIC_BASE_URL || allowedOrigins(env)[0]).replace(/\/$/, '');
const brand = (env) => env.BRAND || 'example.bg';
const nowSec = (now) => Math.floor(now().getTime() / 1000);

// Reads at most `max` bytes; aborts early instead of buffering an oversized body.
const readLimited = async (request, max) => {
  const declared = Number(request.headers.get('Content-Length'));
  if (Number.isFinite(declared) && declared > max) return null;
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let off = 0;
  for (const c of chunks) { all.set(c, off); off += c.byteLength; }
  return all;
};

const readJson = async (request, max) => {
  const type = (request.headers.get('Content-Type') || '').toLowerCase();
  if (!type.startsWith('application/json')) return { status: 415, error: 'unsupported_media_type' };
  try {
    const bytes = await readLimited(request, max);
    if (bytes === null) return { status: 413, error: 'too_large' };
    return { payload: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) };
  } catch {
    return { status: 400, error: 'bad_request' };
  }
};

const getJson = async (env, key) => {
  const obj = await env.UPLOADS.get(key);
  if (!obj) return null;
  try { return JSON.parse(await obj.text()); } catch { return null; }
};
const putJson = (env, key, value) =>
  env.UPLOADS.put(key, JSON.stringify(value), { httpMetadata: { contentType: 'application/json' } });

// Hostnames a Turnstile token may have been issued on: TURNSTILE_HOSTNAMES if set
// (local dev uses Cloudflare's test keys, which report "example.com"), otherwise
// the hosts of ALLOWED_ORIGINS.
const turnstileHostnames = (env) =>
  (env.TURNSTILE_HOSTNAMES
    ? env.TURNSTILE_HOSTNAMES.split(',')
    : allowedOrigins(env).map((o) => { try { return new URL(o).hostname; } catch { return ''; } })
  ).map((h) => h.trim().toLowerCase()).filter(Boolean);

const verifyTurnstile = async (token, ip, env, fetchFn) => {
  if (typeof token !== 'string' || token.length === 0 || token.length > 2048) return 'failed';
  const form = new FormData();
  form.append('secret', env.TURNSTILE_SECRET);
  form.append('response', token);
  if (ip) form.append('remoteip', ip);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 5000);
  try {
    const res = await fetchFn(TURNSTILE_URL, { method: 'POST', body: form, signal: ctl.signal });
    const data = await res.json();
    // A valid token from a page on another hostname (same site key) is still refused.
    const host = typeof data.hostname === 'string' ? data.hostname.toLowerCase() : '';
    return data.success === true && turnstileHostnames(env).includes(host) ? 'ok' : 'failed';
  } catch {
    return 'unavailable';
  } finally {
    clearTimeout(timer);
  }
};

// Starts the scan workflow right away. Failure is not fatal: the workflow also
// runs on a schedule and will pick the files up.
const dispatchScan = async (env, fetchFn) => {
  if (!env.GITHUB_DISPATCH_TOKEN || !env.GITHUB_REPO) return;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 4000);
  try {
    const res = await fetchFn(`https://api.github.com/repos/${env.GITHUB_REPO}/actions/workflows/scan-uploads.yml/dispatches`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.GITHUB_DISPATCH_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'report-form',
      },
      body: JSON.stringify({ ref: env.GITHUB_REF || 'main' }),
      signal: ctl.signal,
    });
    if (!res.ok) console.error('scan dispatch failed:', res.status);
  } catch {
    console.error('scan dispatch failed');
  } finally {
    clearTimeout(timer);
  }
};

const sendMail = async (env, EmailMessage, { subject, text, messageId, date }) => {
  const raw = buildMime({
    from: env.REPORT_FROM,
    fromName: `${brand(env)} reports`,
    to: env.REPORT_TO,
    subject,
    text,
    messageId,
    date,
  });
  await env.SEND_EMAIL.send(new EmailMessage(env.REPORT_FROM, env.REPORT_TO, raw));
};

// Builds and sends the report email (plus the optional links between reports).
// Throws if the email could not be sent.
const sendReport = async (env, deps, { v, id, received, country, files, incomplete = false }) => {
  const intelCfg = intelConfig(env);
  let intel = null;
  let record = null;
  if (intelCfg) {
    try {
      const indicators = await extractIndicators([v.suspect, v.content], { exclude: { phone: v.phone, email: v.email } });
      const macs = await reporterMacs(intelCfg.hmacSecret, { name: v.fullName, phone: v.phone, email: v.email });
      record = { id, receivedAt: received, crimeType: v.crimeType, indicators, macs, reporter: { fullName: v.fullName, phone: v.phone, email: v.email } };
      intel = await findLinks(intelCfg, { indicators, macs, now: received });
    } catch {
      console.error('intel lookup failed');
      intel = { error: true };
    }
  }
  const { subject, text } = buildReportEmail(v, { id, receivedAt: received, country, files, intel, brand: brand(env), incomplete });
  await sendMail(env, deps.EmailMessage, { subject, text, messageId: id.toLowerCase(), date: received });
  if (intelCfg && record) {
    try { await storeReport(intelCfg, record); } catch { console.error('intel store failed'); }
  }
};

// Sends a report that was waiting for its files. Used by /api/finalize and by
// the Cron Trigger. Returns 'sent' | 'gone'. Throws if the email failed (the
// pending report then stays and the Cron Trigger retries).
export const finalizeReport = async (env, deps, id, { incomplete = false } = {}) => {
  const pending = await getJson(env, `pending/${id}.json`);
  if (!pending) return 'gone';
  const sizes = new Map();
  let cursor;
  do {
    const page = await env.UPLOADS.list({ prefix: `quarantine/${id}/`, cursor });
    for (const o of page.objects) sizes.set(o.key.slice(o.key.lastIndexOf('/') + 1), o.size);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  const files = pending.files.map((f) => ({ ...f, arrived: sizes.get(f.name) === f.size }));
  const received = new Date(pending.receivedAt);
  const allIn = files.every((f) => f.arrived);
  await sendReport(env, deps, { v: pending.v, id, received, country: pending.country, files, incomplete: incomplete && !allIn });
  // no personal data from here on: the scanner and the scan email only need this
  await putJson(env, `meta/${id}.json`, { id, crimeType: pending.v.crimeType, receivedAt: pending.receivedAt, files, scanMailed: false });
  await env.UPLOADS.delete(`pending/${id}.json`);
  // a declared file that never fully arrived is dropped, not scanned
  await Promise.allSettled(files.filter((f) => !f.arrived && sizes.has(f.name)).map((f) => env.UPLOADS.delete(keyFor('quarantine', id, f.name))));
  if (files.some((f) => f.arrived)) await dispatchScan(env, deps.fetchFn || fetch);
  return 'sent';
};

const FILE_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Cache-Control': 'private, no-store',
  'Content-Security-Policy': "default-src 'none'; sandbox",
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

const disposition = (name, origName) => {
  const fallback = name;
  if (!origName) return `attachment; filename="${fallback}"`;
  const ext = `.${extOf(name)}`;
  const nice = origName.toLowerCase().endsWith(ext) ? origName : `${origName}${ext}`;
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(nice)}`;
};

// GET /api/file/<reportId>/<uuid.ext>?exp=<unix>&sig=<hmac>
// Serves only from clean/, only with a valid signature (and Cloudflare Access in front).
const handleFile = async (request, env, url, now) => {
  if (request.method !== 'GET' && request.method !== 'HEAD') return json(405, { ok: false, error: 'method_not_allowed' }, { Allow: 'GET, HEAD' });
  const m = url.pathname.match(/^\/api\/file\/([^/]+)\/([^/]+)$/);
  if (!env.UPLOADS || !env.FILE_LINK_SECRET || !m || !REPORT_ID_RE.test(m[1]) || !FILE_NAME_RE.test(m[2])) {
    return json(404, { ok: false, error: 'not_found' });
  }
  const [, id, name] = m;
  const exp = Number(url.searchParams.get('exp'));
  const sig = url.searchParams.get('sig') || '';
  const t = nowSec(now);
  if (!Number.isSafeInteger(exp) || exp > t + LINK_TTL_SECONDS + 60) return json(403, { ok: false, error: 'bad_link' });
  if (exp < t) return json(403, { ok: false, error: 'expired' });
  if (!(await verifyFile(env.FILE_LINK_SECRET, id, name, exp, sig))) return json(403, { ok: false, error: 'bad_link' });

  const obj = await env.UPLOADS.get(keyFor('clean', id, name));
  if (obj) {
    const meta = await getJson(env, `meta/${id}.json`);
    const origName = meta?.files?.find((f) => f.name === name)?.origName || '';
    return new Response(request.method === 'HEAD' ? null : obj.body, {
      status: 200,
      headers: {
        ...FILE_HEADERS,
        'Content-Type': FILE_TYPES[extOf(name)].mime,
        'Content-Disposition': disposition(name, origName),
      },
    });
  }
  if (await env.UPLOADS.head(keyFor('rejected', id, name))) return json(410, { ok: false, error: 'rejected' });
  if (await env.UPLOADS.head(keyFor('quarantine', id, name))) return json(202, { ok: false, error: 'pending' }, { 'Retry-After': '120' });
  return json(404, { ok: false, error: 'not_found' });
};

const checkLink = async (env, url, purpose, id, name, now) => {
  const exp = Number(url.searchParams.get('exp'));
  const sig = url.searchParams.get('sig') || '';
  const t = nowSec(now);
  if (!Number.isSafeInteger(exp) || exp > t + UPLOAD_TTL_SECONDS + 60) return 'bad_link';
  if (exp < t) return 'expired';
  return (await verify(env.FILE_LINK_SECRET, purpose, id, name, exp, sig)) ? '' : 'bad_link';
};

// PUT /api/upload/<id>/<name>?exp&sig  (raw file bytes as the body)
const handleUpload = async (request, env, url, now, cors) => {
  const m = url.pathname.match(/^\/api\/upload\/([^/]+)\/([^/]+)$/);
  if (!env.UPLOADS || !env.FILE_LINK_SECRET || !m || !REPORT_ID_RE.test(m[1]) || !FILE_NAME_RE.test(m[2])) {
    return json(404, { ok: false, error: 'not_found' }, cors);
  }
  if (request.method !== 'PUT') return json(405, { ok: false, error: 'method_not_allowed' }, { ...cors, Allow: 'PUT, OPTIONS' });
  const [, id, name] = m;
  const bad = await checkLink(env, url, 'upload', id, name, now);
  if (bad) return json(403, { ok: false, error: bad }, cors);

  const pending = await getJson(env, `pending/${id}.json`);
  const entry = pending?.files?.find((f) => f.name === name);
  if (!entry) return json(410, { ok: false, error: 'gone' }, cors);
  const declared = Number(request.headers.get('Content-Length'));
  if (!Number.isSafeInteger(declared) || declared !== entry.size || !request.body) {
    return json(411, { ok: false, error: 'length_mismatch' }, cors);
  }

  const key = keyFor('quarantine', id, name);
  try {
    // streamed: the Worker never holds the file in memory
    const put = await env.UPLOADS.put(key, request.body, { httpMetadata: { contentType: 'application/octet-stream' } });
    if (!put || put.size !== entry.size) {
      await env.UPLOADS.delete(key);
      return json(400, { ok: false, error: 'length_mismatch' }, cors);
    }
    const head = await env.UPLOADS.get(key, { range: { offset: 0, length: Math.min(FILE_LIMITS.sniffBytes, entry.size) } });
    const bytes = new Uint8Array(await head.arrayBuffer());
    if (!matchesKind(detectFileType(bytes), entry.kind)) {
      await env.UPLOADS.delete(key);
      return json(415, { ok: false, error: 'bad_type' }, cors);
    }
  } catch {
    console.error('upload failed');
    await env.UPLOADS.delete(key).catch(() => {});
    return json(502, { ok: false, error: 'storage_failed' }, cors);
  }
  return json(200, { ok: true }, cors);
};

// POST /api/finalize/<id>?exp&sig
const handleFinalize = async (request, env, url, deps, cors) => {
  const m = url.pathname.match(/^\/api\/finalize\/([^/]+)$/);
  if (!env.UPLOADS || !m || !REPORT_ID_RE.test(m[1])) return json(404, { ok: false, error: 'not_found' }, cors);
  if (request.method !== 'POST') return json(405, { ok: false, error: 'method_not_allowed' }, { ...cors, Allow: 'POST, OPTIONS' });
  const id = m[1];
  const bad = await checkLink(env, url, 'finalize', id, '', deps.now);
  if (bad) return json(403, { ok: false, error: bad }, cors);
  try {
    const r = await finalizeReport(env, deps, id);
    // 'gone' = already sent (double click, or the Cron Trigger was first)
    return json(200, { ok: true, id, already: r === 'gone' }, cors);
  } catch (err) {
    console.error('finalize failed:', err instanceof Error ? err.name : 'unknown');
    return json(502, { ok: false, error: 'send_failed' }, cors);
  }
};

// POST /api/scan-result  {"id": "..."}  Authorization: Bearer <SCAN_CALLBACK_SECRET>
// The results themselves are read from R2 (results/<id>.json), written by the
// Action with its own R2 credentials, so the request carries no data to trust.
const handleScanResult = async (request, env, deps) => {
  if (request.method !== 'POST') return json(405, { ok: false, error: 'method_not_allowed' }, { Allow: 'POST' });
  const auth = request.headers.get('Authorization') || '';
  if (!env.SCAN_CALLBACK_SECRET || !(await safeEqual(auth, `Bearer ${env.SCAN_CALLBACK_SECRET}`))) {
    return json(401, { ok: false, error: 'unauthorized' });
  }
  const parsed = await readJson(request, 1024);
  if (parsed.error) return json(parsed.status, { ok: false, error: parsed.error });
  const id = parsed.payload?.id;
  if (typeof id !== 'string' || !REPORT_ID_RE.test(id)) return json(400, { ok: false, error: 'bad_request' });

  const [meta, results] = await Promise.all([getJson(env, `meta/${id}.json`), getJson(env, `results/${id}.json`)]);
  if (!meta || !results) return json(404, { ok: false, error: 'not_found' });
  if (meta.scanMailed) return json(200, { ok: true, already: true });

  const exp = nowSec(deps.now) + LINK_TTL_SECONDS;
  const links = {};
  for (const r of results.files || []) {
    if (r.verdict === 'clean' && FILE_NAME_RE.test(r.name)) {
      links[r.name] = `${baseUrl(env)}/api/file/${id}/${r.name}?exp=${exp}&sig=${await signFile(env.FILE_LINK_SECRET, id, r.name, exp)}`;
    }
  }
  try {
    const { subject, text } = buildScanEmail({ id, meta, results, links, brand: brand(env), bucket: env.BUCKET_NAME || '' });
    await sendMail(env, deps.EmailMessage, { subject, text, messageId: `${id.toLowerCase()}-scan`, date: deps.now() });
  } catch (err) {
    console.error('scan mail failed:', err instanceof Error ? err.name : 'unknown');
    return json(502, { ok: false, error: 'send_failed' });
  }
  await putJson(env, `meta/${id}.json`, { ...meta, scanMailed: true });
  return json(200, { ok: true });
};

// POST /api/report
const handleReport = async (request, env, deps, cors) => {
  const { now, fetchFn } = deps;
  if (request.method !== 'POST') return json(405, { ok: false, error: 'method_not_allowed' }, { ...cors, Allow: 'POST, OPTIONS' });

  const parsed = await readJson(request, LIMITS.bodyBytes);
  if (parsed.error) return json(parsed.status, { ok: false, error: parsed.error }, cors);
  const payload = parsed.payload;

  const ip = request.headers.get('CF-Connecting-IP') || '';
  if (env.RATE_LIMITER) {
    const { success } = await env.RATE_LIMITER.limit({ key: ip || 'unknown' });
    if (!success) return json(429, { ok: false, error: 'rate_limited' }, { ...cors, 'Retry-After': '60' });
  }

  const result = validateReport(payload);
  // Honeypot filled: pretend success so the bot learns nothing, send nothing.
  if (result.value?.honeypot) return json(200, { ok: true, id: newReportId(now()) }, cors);

  const manifest = checkManifest(payload?.files);
  const fields = { ...result.errors };
  if (manifest.error) fields.files = manifest.error;
  else if (manifest.files.length && (!env.UPLOADS || !env.FILE_LINK_SECRET)) fields.files = 'unavailable';
  // Files in the "crimes against children" category need an explicit declaration.
  if (manifest.files?.length > 0 && result.value?.crimeType === 'children' && payload.childrenAck !== true) {
    fields.childrenAck = 'required';
  }
  if (Object.keys(fields).length) return json(422, { ok: false, error: 'validation', fields }, cors);

  const captcha = await verifyTurnstile(payload.captchaToken, ip, env, fetchFn);
  if (captcha === 'unavailable') return json(503, { ok: false, error: 'captcha_unavailable' }, cors);
  if (captcha !== 'ok') return json(403, { ok: false, error: 'captcha_failed' }, cors);

  const received = now();
  const id = newReportId(received);
  const country = /^[A-Z]{2}$/.test(request.cf?.country || '') ? request.cf.country : '';
  const v = result.value;

  if (!manifest.files.length) {
    try {
      await sendReport(env, deps, { v, id, received, country, files: [] });
    } catch (err) {
      // Never log the payload or the error text (it could echo personal data).
      console.error('report send failed:', err instanceof Error ? err.name : 'unknown');
      return json(502, { ok: false, error: 'send_failed' }, cors);
    }
    return json(200, { ok: true, id }, cors);
  }

  // With files: keep the report until they are up (at most an hour + the Cron interval).
  const files = manifest.files.map((f) => ({ ...f, name: `${crypto.randomUUID()}.${FILE_TYPES[f.kind].ext}` }));
  try {
    await putJson(env, `pending/${id}.json`, { v, receivedAt: received.toISOString(), country, files });
  } catch {
    console.error('pending store failed');
    return json(502, { ok: false, error: 'storage_failed' }, cors);
  }
  const exp = Math.floor(received.getTime() / 1000) + UPLOAD_TTL_SECONDS;
  const uploads = await Promise.all(
    files.map(async (f) => ({
      name: f.name,
      url: `/api/upload/${id}/${f.name}?exp=${exp}&sig=${await sign(env.FILE_LINK_SECRET, 'upload', id, f.name, exp)}`,
    })),
  );
  const finalize = `/api/finalize/${id}?exp=${exp}&sig=${await sign(env.FILE_LINK_SECRET, 'finalize', id, '', exp)}`;
  return json(200, { ok: true, id, uploads, finalize }, cors);
};

export const handleRequest = async (request, env, { EmailMessage, fetchFn = fetch, now = () => new Date() } = {}) => {
  const deps = { EmailMessage, fetchFn, now };
  const url = new URL(request.url);

  // Opened from an email (no Origin header, no CORS) / called by the GitHub Action.
  if (url.pathname.startsWith('/api/file/')) return handleFile(request, env, url, now);
  if (url.pathname === '/api/scan-result') return handleScanResult(request, env, deps);

  const isForm = url.pathname === '/api/report' || url.pathname.startsWith('/api/upload/') || url.pathname.startsWith('/api/finalize/');
  if (!isForm) return json(404, { ok: false, error: 'not_found' });

  const origin = request.headers.get('Origin');
  const originOk = origin !== null && allowedOrigins(env).includes(origin);
  const cors = originOk
    ? {
        'Access-Control-Allow-Origin': origin,
        Vary: 'Origin',
        'Access-Control-Allow-Methods': 'POST, PUT, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Max-Age': '600',
      }
    : {};
  if (!originOk) return json(403, { ok: false, error: 'forbidden_origin' });
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

  if (url.pathname === '/api/report') return handleReport(request, env, deps, cors);
  if (url.pathname.startsWith('/api/upload/')) return handleUpload(request, env, url, now, cors);
  return handleFinalize(request, env, url, deps, cors);
};

// Cron Trigger: sends reports whose browser never called /api/finalize (tab
// closed, connection lost) once their upload links have expired.
export const sendStalePending = async (env, deps) => {
  if (!env.UPLOADS) return;
  const cutoff = deps.now().getTime() - (UPLOAD_TTL_SECONDS + 300) * 1000;
  const page = await env.UPLOADS.list({ prefix: 'pending/', limit: 50 });
  for (const o of page.objects) {
    const m = o.key.match(/^pending\/(.+)\.json$/);
    if (!m || !REPORT_ID_RE.test(m[1]) || new Date(o.uploaded).getTime() > cutoff) continue;
    try {
      await finalizeReport(env, deps, m[1], { incomplete: true });
    } catch {
      console.error('stale finalize failed');
    }
  }
};
