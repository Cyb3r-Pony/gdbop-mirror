#!/usr/bin/env node
// Search the links between reports (D1) from an authorised machine; nothing
// about this is reachable from the internet. Reads through `wrangler d1
// execute` with your own Cloudflare login, opens the reporters' data locally
// with INTEL_ENC_KEY and prints tables; optionally writes CSV and an offline
// HTML report with a graph of the links. Every search is written to audit_log.
//
// The keys are asked for without echo (or taken from INTEL_ENC_KEY /
// INTEL_HMAC_KEY in the environment) and are never written anywhere.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { runSearch, renderTables, renderCsv, renderHtml, UserError } from './intel-lib.mjs';
import { fromB64url, DEFAULT_RETENTION_DAYS } from '../src/intel.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const workerDir = path.resolve(here, '..');

const USAGE = `Търсене във връзките между сигналите

  node scripts/intel.mjs find   <стойност>   сайт, профил, имейл, телефон, IBAN, крипто адрес, @име
  node scripts/intel.mjs report <номер>      напр. MVR-GDBOP-20261025-PM9PR
  node scripts/intel.mjs name   "<три имена>"   подател
  node scripts/intel.mjs phone  <телефон>    подател
  node scripts/intel.mjs email  <имейл>      подател
  node scripts/intel.mjs top    [--days 30]  идентификатори, подадени поне 2 пъти

Опции:
  --depth N        1 = намерените сигнали; 2 = и сигналите, които споделят идентификатор с тях;
                   3 = още една стъпка. По подразбиране: 1 за find/top, 2 за останалите.
  --csv FILE       запиши таблица за Excel (по ред за всеки сигнал и идентификатор)
  --html FILE      запиши офлайн отчет с таблици и графика на връзките
  --local          локалната база на wrangler dev вместо истинската
  --persist-to DIR, --config FILE, --db NAME   за wrangler

Ключовете се въвеждат скрито (или от INTEL_ENC_KEY / INTEL_HMAC_KEY в средата).
CSV и HTML файловете съдържат лични данни: не ги препращайте и ги изтривайте след работа.`;

const parseArgs = (argv) => {
  const opts = { flags: {} };
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--local' || a === '-h' || a === '--help') opts.flags[a.replace(/^-+/, '')] = true;
    else if (a.startsWith('--')) {
      if (i + 1 >= argv.length) throw new UserError(`Липсва стойност за ${a}`);
      opts.flags[a.slice(2)] = argv[(i += 1)];
    } else rest.push(a);
  }
  [opts.kind, ...opts.args] = rest;
  return opts;
};

const readConfig = (file) => {
  let text = '';
  try { text = readFileSync(file, 'utf8'); } catch { /* defaults */ }
  const days = text.match(/^REPORTER_RETENTION_DAYS\s*=\s*"(\d+)"/m);
  const db = text.match(/^database_name\s*=\s*"([^"]+)"/m);
  return { retentionDays: days ? Number(days[1]) : DEFAULT_RETENTION_DAYS, db: db ? db[1] : 'report-intel' };
};

// Reads a line without echoing it (falls back to a plain line when not a terminal).
const askHidden = (prompt) =>
  new Promise((resolve) => {
    const { stdin, stderr } = process;
    stderr.write(prompt);
    if (!stdin.isTTY) {
      let buf = '';
      stdin.setEncoding('utf8');
      stdin.on('data', (c) => { buf += c; });
      stdin.on('end', () => resolve(buf.split(/\r?\n/)[0]));
      return;
    }
    let buf = '';
    stdin.setRawMode(true);
    stdin.setEncoding('utf8');
    stdin.resume();
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off('data', onData);
          stderr.write('\n');
          resolve(buf);
          return;
        }
        if (ch === '\u0003') { stdin.setRawMode(false); stderr.write('\n'); process.exit(130); }
        if (ch === '\u007f' || ch === '\b') buf = buf.slice(0, -1);
        else buf += ch;
      }
    };
    stdin.on('data', onData);
  });

const encKeyFrom = (s) => {
  try {
    const bytes = fromB64url(String(s).trim().replace(/=+$/, ''));
    if (bytes.length === 32) return bytes;
  } catch { /* below */ }
  throw new UserError('INTEL_ENC_KEY трябва да е 32 байта в base64 (както е създаден с openssl rand -base64 32).');
};

const wranglerExec = ({ db, local, persistTo, config }) => (sql) => {
  const bin = path.join(workerDir, 'node_modules', '.bin', 'wrangler');
  const args = ['d1', 'execute', db, local ? '--local' : '--remote', '--json', '--command', sql];
  if (persistTo) args.push('--persist-to', persistTo);
  if (config) args.push('--config', config);
  const res = spawnSync(bin, args, { cwd: workerDir, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (res.error) throw new UserError(`wrangler не може да се стартира (${res.error.code}). Пуснете npm ci в worker/.`);
  let out;
  try { out = JSON.parse(res.stdout); } catch { out = null; }
  if (res.status !== 0 || !Array.isArray(out)) {
    const msg = (out && out.error && out.error.text) || res.stderr || res.stdout || '';
    if (/Couldn't find a D1 DB|not found/i.test(msg)) throw new UserError(`Базата "${db}" не е намерена: проверете блока [[d1_databases]] в wrangler.toml.`);
    if (/login|authenticat/i.test(msg)) throw new UserError('Не сте влезли в Cloudflare: npx wrangler login');
    throw new UserError(`wrangler d1 execute се провали: ${msg.split('\n').find((l) => l.trim()) || res.status}`);
  }
  return out[0].results ?? [];
};

const writePrivate = (file, content) => {
  try {
    writeFileSync(file, content, { flag: 'wx', mode: 0o600 });
  } catch (e) {
    if (e.code === 'EEXIST') throw new UserError(`${file} вече съществува: изберете друго име или го изтрийте.`);
    throw e;
  }
};

const main = async () => {
  const { kind, args, flags } = parseArgs(process.argv.slice(2));
  if (!kind || flags.h || flags.help) {
    console.log(USAGE);
    return;
  }
  const q = args.join(' ').trim();
  if (kind !== 'top' && !q) throw new UserError(`Липсва стойност за търсене.\n\n${USAGE}`);
  const depth = flags.depth ? Number(flags.depth) : ['find', 'top'].includes(kind) ? 1 : 2;
  if (!Number.isInteger(depth) || depth < 1 || depth > 3) throw new UserError('--depth е 1, 2 или 3.');
  const days = flags.days ? Number(flags.days) : 30;
  if (!Number.isInteger(days) || days < 1 || days > 3650) throw new UserError('--days е между 1 и 3650.');

  const configFile = flags.config ? path.resolve(flags.config) : path.join(workerDir, 'wrangler.toml');
  const cfg = readConfig(configFile);
  const exec = wranglerExec({ db: flags.db || cfg.db, local: Boolean(flags.local), persistTo: flags['persist-to'], config: flags.config && configFile });

  const encKey = encKeyFrom(process.env.INTEL_ENC_KEY || (await askHidden('INTEL_ENC_KEY: ')));
  const needsHmac = ['name', 'phone', 'email'].includes(kind);
  const hmacSecret = needsHmac ? process.env.INTEL_HMAC_KEY || (await askHidden('INTEL_HMAC_KEY: ')) : '';
  if (needsHmac && hmacSecret.length < 32) throw new UserError('INTEL_HMAC_KEY е поне 32 знака.');

  const model = await runSearch(exec, {
    kind, q, depth, days, encKey, hmacSecret, retentionDays: cfg.retentionDays, now: new Date(), who: `${os.userInfo().username}@${os.hostname()}`,
  });
  console.log(renderTables(model));

  const written = [];
  if (flags.csv) { writePrivate(flags.csv, renderCsv(model)); written.push(flags.csv); }
  if (flags.html) { writePrivate(flags.html, renderHtml(model)); written.push(flags.html); }
  if (written.length) {
    console.log(`\nЗаписано: ${written.join(', ')}`);
    console.log('Файловете съдържат лични данни: не ги препращайте и ги изтрийте след работа.');
  }
};

main().catch((e) => {
  console.error(e instanceof UserError ? e.message : `Грешка: ${e.message}`);
  process.exit(1);
});
