import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleRequest, sendStalePending } from '../src/handler.js';
import { detectFileType, matchesKind, checkManifest, cleanFileName, FILE_LIMITS, FILE_TYPES } from '../src/files.js';
import { signFile, verifyFile, sign, verify } from '../src/sign.js';
import { route } from '../src/router.js';

const ORIGIN = 'https://example.bg';
const egn = (() => {
  const base = '900512123';
  const w = [2, 4, 8, 5, 10, 9, 7, 3, 6];
  return base + ((w.reduce((a, wi, i) => a + wi * Number(base[i]), 0) % 11) % 10);
})();

const enc = new TextEncoder();
const pad = (head, n = 64) => { const b = new Uint8Array(Math.max(n, head.length)); b.set(head); return b; };
const PNG = pad([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82]);
const JPG = pad([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1]);
const WEBP = pad([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50]);
const PDF = enc.encode('%PDF-1.7\n%\xe2\xe3\n1 0 obj << /Type /Catalog >> endobj\ntrailer\n%%EOF\n');
const EML = enc.encode('Return-Path: <a@b.example>\r\nReceived: from mx.example by mx2.example\r\nFrom: "Bank" <noreply@bank-secure.example>\r\nTo: victim@example.com\r\nSubject: Your account\r\nMessage-ID: <1@x>\r\nMIME-Version: 1.0\r\n\r\nHello\r\n');
const OLE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const MSG = (() => { const b = new Uint8Array(4096); b.set(OLE); b.set(Array.from('__substg1.0_0037001F').flatMap((c) => [c.charCodeAt(0), 0]), 2000); return b; })();
const DOC = pad(OLE, 4096);
const GIF = pad([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0, 0, 0, 0, 0, 0]);
const EXE = pad([0x4d, 0x5a, 0x90, 0, 3, 0, 0, 0, 4, 0, 0, 0]);
const TXT = enc.encode('Just some notes about the case, nothing header-like here at all.\nSecond line.\n');

const report = (over = {}) => ({
  crimeType: 'phishing',
  alreadyReported: 'no',
  fullName: 'Иван Петров Георгиев',
  egn,
  phone: '0888123456',
  email: 'ivan@example.com',
  content: 'Получих SMS с линк към фалшив сайт на банка и въведох данните си там.',
  consent: true,
  notEmergency: true,
  truthDeclaration: true,
  captchaToken: 'tok',
  ...over,
});

const post = (path, body, headers = {}) =>
  new Request(`https://example.bg${path}`, {
    method: 'POST',
    headers: { Origin: ORIGIN, 'CF-Connecting-IP': '203.0.113.9', 'Content-Type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
const put = (path, bytes, headers = {}) =>
  new Request(`https://example.bg${path}`, {
    method: 'PUT',
    headers: { Origin: ORIGIN, 'Content-Length': String(bytes.length), ...headers },
    body: bytes,
  });

const toBytes = async (body) => {
  if (body instanceof Uint8Array) return body;
  if (typeof body === 'string') return enc.encode(body);
  if (body && typeof body.getReader === 'function') return new Uint8Array(await new Response(body).arrayBuffer());
  return new Uint8Array(await new Response(body).arrayBuffer());
};

// Small in-memory stand-in for an R2 binding.
const makeR2 = (clock = () => new Date()) => {
  const m = new Map();
  const obj = (k, range) => {
    const { bytes, opts, uploaded } = m.get(k);
    const b = range ? bytes.subarray(range.offset, range.offset + range.length) : bytes;
    return {
      key: k, size: bytes.length, uploaded, httpMetadata: opts?.httpMetadata,
      body: new Response(b).body,
      arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength),
      text: async () => new TextDecoder().decode(b),
    };
  };
  return {
    m,
    put: async (k, body, opts) => { const bytes = await toBytes(body); m.set(k, { bytes, opts, uploaded: clock() }); return { key: k, size: bytes.length }; },
    get: async (k, o = {}) => (m.has(k) ? obj(k, o.range) : null),
    head: async (k) => (m.has(k) ? { key: k, size: m.get(k).bytes.length } : null),
    delete: async (k) => { m.delete(k); },
    list: async ({ prefix = '' } = {}) => ({
      objects: [...m.keys()].filter((k) => k.startsWith(prefix)).map((k) => ({ key: k, size: m.get(k).bytes.length, uploaded: m.get(k).uploaded })),
      truncated: false,
    }),
  };
};

const setup = ({ github = 204, uploads, noBinding = false, now = '2026-10-25T12:00:00Z' } = {}) => {
  const clock = { t: new Date(now) };
  uploads = uploads || makeR2(() => clock.t);
  const sent = [];
  const calls = [];
  const env = {
    ALLOWED_ORIGINS: ORIGIN,
    PUBLIC_BASE_URL: ORIGIN,
    REPORT_FROM: 'reports@example.bg',
    REPORT_TO: 'inbox@example.org',
    TURNSTILE_SECRET: 's',
    FILE_LINK_SECRET: 'link-secret',
    SCAN_CALLBACK_SECRET: 'scan-secret',
    GITHUB_REPO: 'owner/repo',
    GITHUB_DISPATCH_TOKEN: 'ghp_test',
    BRAND: 'gdbop-demo',
    BUCKET_NAME: 'bucket',
    SEND_EMAIL: { send: async (msg) => { sent.push(msg); } },
    ...(noBinding ? {} : { UPLOADS: uploads }),
  };
  const deps = {
    EmailMessage: class { constructor(from, to, raw) { Object.assign(this, { from, to, raw }); } },
    fetchFn: async (url, init) => {
      calls.push({ url: String(url), init });
      if (String(url).includes('github.com')) return new Response(null, { status: github });
      return new Response(JSON.stringify({ success: true, hostname: 'example.bg' }));
    },
    now: () => clock.t,
  };
  return { env, deps, sent, calls, uploads, clock };
};

const emailText = (raw) => Buffer.from(raw.split('\r\n\r\n')[1].replace(/\r\n/g, ''), 'base64').toString('utf8');
const subjectOf = (raw) => raw.match(/^Subject: (.*)$/m)[1];
const linksIn = (text) => [...text.matchAll(/https:\/\/example\.bg\/api\/file\/\S+/g)].map((m) => m[0]);

// Runs the whole browser side: report + manifest, each upload, finalize.
const submit = async (ctx, files, over = {}) => {
  const manifest = files.map(([kind, bytes, name]) => ({ kind, size: bytes.length, name: name || `file.${kind}` }));
  const res = await handleRequest(post('/api/report', report({ files: manifest, ...over })), ctx.env, ctx.deps);
  const body = await res.json();
  return { res, body, manifest };
};
const uploadAll = async (ctx, body, files) => {
  const out = [];
  for (let i = 0; i < files.length; i++) {
    const r = await handleRequest(put(body.uploads[i].url, files[i][1]), ctx.env, ctx.deps);
    out.push(r.status);
  }
  return out;
};

test('detectFileType identifies each allowed kind by its bytes', () => {
  assert.equal(detectFileType(PNG), 'png');
  assert.equal(detectFileType(JPG), 'jpg');
  assert.equal(detectFileType(WEBP), 'webp');
  assert.equal(detectFileType(PDF), 'pdf');
  assert.equal(detectFileType(EML), 'eml');
  assert.equal(detectFileType(MSG), 'msg');
  assert.equal(detectFileType(DOC), 'msg?'); // OLE2 without the marker in view: the scanner decides
  for (const bad of [GIF, EXE, TXT, new Uint8Array(3), enc.encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>'), enc.encode('<html><body>Subject: x</body></html>')]) {
    assert.equal(detectFileType(bad), '', 'should refuse');
  }
  assert.equal(matchesKind('msg?', 'msg'), true);
  assert.equal(matchesKind('msg?', 'pdf'), false);
  assert.equal(matchesKind('pdf', 'eml'), false);
});

test('manifest limits: count, per-kind size, total, kinds', () => {
  const MB = 1024 * 1024;
  assert.deepEqual(checkManifest(undefined), { files: [] });
  assert.equal(checkManifest(Array.from({ length: FILE_LIMITS.maxFiles + 1 }, () => ({ kind: 'png', size: 10 }))).error, 'too_many');
  assert.equal(checkManifest([{ kind: 'png', size: 10 * MB + 1 }]).error, 'too_large');
  assert.equal(checkManifest([{ kind: 'pdf', size: 20 * MB }]).files.length, 1);
  assert.equal(checkManifest([{ kind: 'pdf', size: 20 * MB }, { kind: 'msg', size: 20 * MB }, { kind: 'eml', size: 11 * MB }]).error, 'total_too_large');
  assert.equal(checkManifest([{ kind: 'exe', size: 10 }]).error, 'bad_type');
  assert.equal(checkManifest([{ kind: 'png', size: 0 }]).error, 'bad_type');
  assert.equal(checkManifest([{ kind: 'png', size: 1.5 }]).error, 'bad_type');
  assert.equal(checkManifest('x').error, 'bad_request');
});

test('original file names are cleaned for the email', () => {
  assert.equal(cleanFileName('C:\\Users\\me\\Фактура №5.pdf'), 'Фактура No5.pdf');
  assert.equal(cleanFileName('evil\u202Egnp.exe'), 'evilgnp.exe');
  assert.equal(cleanFileName('a\r\nSubject: x.png'), 'aSubject_ x.png');
  assert.equal(cleanFileName('x'.repeat(300) + '.pdf').length, FILE_LIMITS.maxNameLength);
  assert.ok(cleanFileName('x'.repeat(300) + '.pdf').endsWith('.pdf'));
  assert.equal(cleanFileName(42), '');
});

test('signatures are bound to purpose, id, name and expiry', async () => {
  const id = 'MVR-GDBOP-20261025-ABCDE';
  const sig = await signFile('k', id, 'a.png', 123);
  assert.equal(await verifyFile('k', id, 'a.png', 123, sig), true);
  assert.equal(await verifyFile('k', id, 'a.png', 124, sig), false);
  assert.equal(await verifyFile('k', id, 'b.png', 123, sig), false);
  assert.equal(await verifyFile('other', id, 'a.png', 123, sig), false);
  assert.equal(await verifyFile('k', id, 'a.png', 123, '%%%'), false);
  const up = await sign('k', 'upload', id, 'a.png', 123);
  assert.equal(await verify('k', 'upload', id, 'a.png', 123, up), true);
  assert.equal(await verifyFile('k', id, 'a.png', 123, up), false, 'an upload link is not a download link');
});

test('full flow: report waits, files stream to quarantine, finalize sends one email and starts the scan', async () => {
  const ctx = setup();
  const files = [['png', PNG, 'screen.png'], ['pdf', PDF, 'Договор.pdf'], ['eml', EML, 'phish.eml'], ['msg', MSG, 'mail.msg']];
  const { res, body } = await submit(ctx, files);
  assert.equal(res.status, 200);
  assert.match(body.id, /^MVR-GDBOP-20261025-[A-Z2-9]{5}$/);
  assert.equal(body.uploads.length, 4);
  assert.equal(ctx.sent.length, 0, 'nothing is sent before the files are up');
  assert.ok(ctx.uploads.m.has(`pending/${body.id}.json`));

  assert.deepEqual(await uploadAll(ctx, body, files), [200, 200, 200, 200]);
  const q = [...ctx.uploads.m.keys()].filter((k) => k.startsWith('quarantine/'));
  assert.equal(q.length, 4);
  for (const k of q) assert.match(k, new RegExp(`^quarantine/${body.id}/[0-9a-f-]{36}\\.(png|pdf|eml|msg)$`));

  const fin = await handleRequest(post(body.finalize, ''), ctx.env, ctx.deps);
  assert.equal(fin.status, 200);
  assert.equal(ctx.sent.length, 1);
  const text = emailText(ctx.sent[0].raw);
  assert.match(subjectOf(ctx.sent[0].raw), /^\[gdbop-demo\] New report MVR-GDBOP-/);
  assert.match(text, /Вид престъпление: Киберпрестъпност › Фишинг/);
  assert.match(text, /Декларирани: 4, получени: 4/);
  assert.match(text, /PDF, 1 KB, "Договор\.pdf" - в карантина/);
  assert.match(text, /MSG, 4 KB, "mail\.msg" - в карантина/);
  assert.equal(linksIn(text).length, 0, 'links come with the scan email');
  assert.doesNotMatch(ctx.sent[0].raw, /multipart|Content-Disposition/i);

  assert.ok(!ctx.uploads.m.has(`pending/${body.id}.json`), 'personal data is gone from R2 once sent');
  const meta = JSON.parse(new TextDecoder().decode(ctx.uploads.m.get(`meta/${body.id}.json`).bytes));
  assert.equal(meta.files.length, 4);
  assert.equal(meta.scanMailed, false);
  assert.doesNotMatch(JSON.stringify(meta), /Иван|0888|ivan@/);

  const gh = ctx.calls.find((c) => c.url.includes('api.github.com'));
  assert.equal(gh.url, 'https://api.github.com/repos/owner/repo/actions/workflows/scan-uploads.yml/dispatches');
  assert.equal(gh.init.headers.Authorization, 'Bearer ghp_test');

  // a second finalize (double click) sends nothing more
  const again = await handleRequest(post(body.finalize, ''), ctx.env, ctx.deps);
  assert.equal((await again.json()).already, true);
  assert.equal(ctx.sent.length, 1);
});

test('report without files is sent at once (no pending state)', async () => {
  const ctx = setup();
  const res = await handleRequest(post('/api/report', report()), ctx.env, ctx.deps);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.uploads, undefined);
  assert.equal(ctx.sent.length, 1);
  assert.match(emailText(ctx.sent[0].raw), /== ПРИКАЧЕНИ ФАЙЛОВЕ ==\nНяма\./);
  assert.equal(ctx.uploads.m.size, 0);
});

test('uploads: content must match the declared kind and size; links are checked', async () => {
  const ctx = setup();
  const files = [['png', PNG], ['pdf', PDF], ['eml', EML], ['msg', MSG]];
  const { body } = await submit(ctx, files);
  const [u0, u1, u2, u3] = body.uploads;

  // an executable declared as a PNG (same size) is refused and not kept
  const fakePng = new Uint8Array(PNG.length); fakePng.set(EXE.subarray(0, 12));
  assert.equal((await handleRequest(put(u0.url, fakePng), ctx.env, ctx.deps)).status, 415);
  assert.equal([...ctx.uploads.m.keys()].filter((k) => k.startsWith('quarantine/')).length, 0);
  // wrong length
  assert.equal((await handleRequest(put(u1.url, PDF.subarray(1)), ctx.env, ctx.deps)).status, 411);
  // a PDF uploaded to the EML slot (sizes forced equal) is refused
  const pdfAsEml = new Uint8Array(EML.length); pdfAsEml.set(PDF.subarray(0, Math.min(PDF.length, EML.length)));
  assert.equal((await handleRequest(put(u2.url, pdfAsEml), ctx.env, ctx.deps)).status, 415);
  // a Word .doc (OLE2, no Outlook streams) in the MSG slot passes the head check; the scanner rejects it later
  assert.equal((await handleRequest(put(u3.url, DOC.subarray(0, MSG.length)), ctx.env, ctx.deps)).status, 200);

  // tampered / foreign / expired links
  const tampered = u0.url.replace(/sig=[^&]+/, 'sig=AAAA');
  assert.equal((await handleRequest(put(tampered, PNG), ctx.env, ctx.deps)).status, 403);
  const otherName = u0.url.replace(/\/[0-9a-f-]{36}\.png/, '/00000000-0000-4000-8000-000000000000.png');
  assert.equal((await handleRequest(put(otherName, PNG), ctx.env, ctx.deps)).status, 403);
  ctx.clock.t = new Date(ctx.clock.t.getTime() + 2 * 3600 * 1000);
  assert.equal((await handleRequest(put(u0.url, PNG), ctx.env, ctx.deps)).status, 403);
});

test('uploads need the form origin; only PUT', async () => {
  const ctx = setup();
  const { body } = await submit(ctx, [['png', PNG]]);
  const u = body.uploads[0].url;
  assert.equal((await handleRequest(put(u, PNG, { Origin: 'https://evil.example' }), ctx.env, ctx.deps)).status, 403);
  const get = new Request(`https://example.bg${u}`, { headers: { Origin: ORIGIN } });
  assert.equal((await handleRequest(get, ctx.env, ctx.deps)).status, 405);
});

test('validation: bad manifest is a field error and the captcha is not used', async () => {
  const ctx = setup();
  const res = await handleRequest(post('/api/report', report({ files: [{ kind: 'exe', size: 10 }] })), ctx.env, ctx.deps);
  assert.equal(res.status, 422);
  assert.equal((await res.json()).fields.files, 'bad_type');
  assert.equal(ctx.calls.length, 0);
  const noBinding = setup({ noBinding: true });
  const r2 = await handleRequest(post('/api/report', report({ files: [{ kind: 'png', size: 10 }] })), noBinding.env, noBinding.deps);
  assert.equal((await r2.json()).fields.files, 'unavailable');
});

test('children category: files need the declaration', async () => {
  const ctx = setup();
  const r = await handleRequest(post('/api/report', report({ crimeType: 'children', files: [{ kind: 'png', size: PNG.length }] })), ctx.env, ctx.deps);
  assert.equal(r.status, 422);
  assert.equal((await r.json()).fields.childrenAck, 'required');
  const ok = await handleRequest(post('/api/report', report({ crimeType: 'children', childrenAck: true, files: [{ kind: 'png', size: PNG.length }] })), ctx.env, ctx.deps);
  assert.equal(ok.status, 200);
});

test('abandoned upload: the Cron Trigger sends what arrived after the links expire', async () => {
  const ctx = setup();
  const files = [['png', PNG, 'a.png'], ['pdf', PDF, 'b.pdf']];
  const { body } = await submit(ctx, files);
  await handleRequest(put(body.uploads[0].url, PNG), ctx.env, ctx.deps); // only the first one
  await sendStalePending(ctx.env, ctx.deps);
  assert.equal(ctx.sent.length, 0, 'too early');
  ctx.clock.t = new Date(ctx.clock.t.getTime() + 2 * 3600 * 1000);
  await sendStalePending(ctx.env, { ...ctx.deps, now: () => ctx.clock.t });
  assert.equal(ctx.sent.length, 1);
  const text = emailText(ctx.sent[0].raw);
  assert.match(text, /Декларирани: 2, получени: 1/);
  assert.match(text, /не завърши качването/);
  assert.match(text, /"b\.pdf" - НЕ Е ПОЛУЧЕН/);
});

// Simulates the GitHub Action: moves files and writes results/<id>.json.
const scanInto = (ctx, id, verdicts) => {
  const meta = JSON.parse(new TextDecoder().decode(ctx.uploads.m.get(`meta/${id}.json`).bytes));
  const files = meta.files.map((f, i) => {
    const v = verdicts[i];
    const src = ctx.uploads.m.get(`quarantine/${id}/${f.name}`);
    ctx.uploads.m.delete(`quarantine/${id}/${f.name}`);
    ctx.uploads.m.set(`${v.verdict === 'clean' ? 'clean' : 'rejected'}/${id}/${f.name}`, src);
    return { name: f.name, size: f.size, sha256: 'ab'.repeat(32), md5: 'cd'.repeat(16), ...v };
  });
  ctx.uploads.m.set(`results/${id}.json`, { bytes: enc.encode(JSON.stringify({ id, scannedAt: '2026-10-25T12:05:00Z', clamavVersion: 'ClamAV 1.4/27800', files })), uploaded: new Date() });
};
const scanResult = (id, secret = 'scan-secret') =>
  new Request('https://example.bg/api/scan-result', {
    method: 'POST',
    headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ id }),
  });

test('scan result email: hashes, ClamAV, VirusTotal, links only for clean files, sent once', async () => {
  const ctx = setup();
  const files = [['png', PNG, 'screen.png'], ['pdf', PDF, 'invoice.pdf'], ['eml', EML, 'phish.eml']];
  const { body } = await submit(ctx, files);
  await uploadAll(ctx, body, files);
  await handleRequest(post(body.finalize, ''), ctx.env, ctx.deps);
  scanInto(ctx, body.id, [
    { verdict: 'clean', clamav: 'clean', vt: { status: 'unknown' } },
    { verdict: 'rejected', reason: 'infected', clamav: 'infected', signature: 'Pdf.Exploit.CVE_2018_4882-1', vt: { status: 'found', malicious: 31, suspicious: 2, total: 66 }, pdfFlags: ['javascript', 'openaction'] },
    { verdict: 'clean', clamav: 'clean', vt: { status: 'found', malicious: 0, total: 64 }, mail: { subject: 'Verify at https://bank-secure.example/login', from: 'noreply@bank-secure.example', attachments: [{ name: 'invoice.zip', size: 2048, sha256: 'ef'.repeat(32), vt: { status: 'found', malicious: 12, total: 60 } }], urlCount: 3 } },
  ]);

  assert.equal((await handleRequest(scanResult(body.id, 'wrong'), ctx.env, ctx.deps)).status, 401);
  const res = await handleRequest(scanResult(body.id), ctx.env, ctx.deps);
  assert.equal(res.status, 200);
  assert.equal(ctx.sent.length, 2);
  const raw = ctx.sent[1].raw;
  assert.match(subjectOf(raw), /^\[gdbop-demo\] Scan results MVR-GDBOP-\S+: 2 clean, 1 rejected$/);
  const text = emailText(raw);
  assert.match(text, /SHA-256: (ab){32}/);
  assert.match(text, /ClamAV: ЗАРАЗЕН \(Pdf\.Exploit\.CVE_2018_4882-1\)/);
  assert.match(text, /VirusTotal: 31\/66 антивирусни програми го определят като зловреден, подозрителен за 2/);
  assert.match(text, /PDF съдържа: JavaScript; автоматично действие/);
  assert.match(text, /rejected\/MVR-GDBOP-\S+\.pdf/);
  assert.match(text, /прикачен файл 1: "invoice\.zip".*SHA-256 (ef){32}/);
  assert.match(text, /VirusTotal: 12\/60/);
  assert.match(text, /hxxps\[:\/\/\]bank-secure\[\.\]example/);
  assert.doesNotMatch(text, /https:\/\/bank-secure\.example/);
  assert.match(text, /непознат хеш/);
  const links = linksIn(text);
  assert.equal(links.length, 2, 'only the two clean files get links');

  // each link downloads its clean file with the right type and the original name
  const dl = await handleRequest(new Request(links[0]), ctx.env, ctx.deps);
  assert.equal(dl.status, 200);
  assert.equal(dl.headers.get('Content-Type'), 'image/png');
  assert.match(dl.headers.get('Content-Disposition'), /filename\*=UTF-8''screen\.png/);
  assert.equal(dl.headers.get('Content-Security-Policy'), "default-src 'none'; sandbox");
  const dl2 = await handleRequest(new Request(links[1]), ctx.env, ctx.deps);
  assert.equal(dl2.headers.get('Content-Type'), 'message/rfc822');

  // idempotent: the Action retrying does not send a second scan email
  const again = await handleRequest(scanResult(body.id), ctx.env, ctx.deps);
  assert.equal((await again.json()).already, true);
  assert.equal(ctx.sent.length, 2);
});

test('download links: rejected → 410, still in quarantine → 202, expired / forged → 403', async () => {
  const ctx = setup();
  const id = 'MVR-GDBOP-20261025-ABCDE';
  const exp = Math.floor(ctx.clock.t.getTime() / 1000) + 3600;
  const link = async (name) => `https://example.bg/api/file/${id}/${name}?exp=${exp}&sig=${await signFile('link-secret', id, name, exp)}`;
  const n1 = '11111111-1111-4111-8111-111111111111.pdf';
  const n2 = '22222222-2222-4222-8222-222222222222.msg';
  await ctx.uploads.put(`rejected/${id}/${n1}`, PDF);
  await ctx.uploads.put(`quarantine/${id}/${n2}`, MSG);
  assert.equal((await handleRequest(new Request(await link(n1)), ctx.env, ctx.deps)).status, 410);
  assert.equal((await handleRequest(new Request(await link(n2)), ctx.env, ctx.deps)).status, 202);
  const forged = (await link(n1)).replace(/sig=[^&]+/, 'sig=x');
  assert.equal((await handleRequest(new Request(forged), ctx.env, ctx.deps)).status, 403);
  ctx.clock.t = new Date(ctx.clock.t.getTime() + 7200 * 1000);
  assert.equal((await handleRequest(new Request(await link(n1)), ctx.env, ctx.deps)).status, 403);
  // an upload link can't be used to download
  const up = `https://example.bg/api/file/${id}/${n1}?exp=${exp}&sig=${await sign('link-secret', 'upload', id, n1, exp)}`;
  assert.equal((await handleRequest(new Request(up), setup().env, setup().deps)).status, 403);
});

test('maintenance mode still lets the scanner report and links download', async () => {
  const ctx = setup();
  const env = { ...ctx.env, MAINTENANCE: 'true', ASSETS: { fetch: () => new Response('page') } };
  assert.equal((await route(post('/api/report', report()), env, ctx.deps)).status, 503);
  assert.notEqual((await route(scanResult('MVR-GDBOP-20261025-ABCDE'), env, ctx.deps)).status, 503);
});

test('every kind has a size limit within the total', () => {
  for (const t of Object.values(FILE_TYPES)) assert.ok(t.maxBytes <= FILE_LIMITS.maxTotalBytes);
});
