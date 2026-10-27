// Assembles ./public, the static files Cloudflare serves at example.bg.
// The page (site/index.html) and headers (site/_headers) live here; the compiled
// JS/CSS, fonts and the few images it uses are copied from the repo root, so
// there is a single source for them. Run `node ../build.mjs` first (the
// "deploy" script does) so assets/js/dist/report.bundle.js is current.
import { cpSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const out = path.join(here, 'public');

const files = [
  'assets/js/dist/report.bundle.js',
  'assets/css/tailwind.min.css',
  'assets/css/montserrat.css',
  'assets/webfonts/montserrat-300.ttf',
  'assets/webfonts/montserrat-400.ttf',
  'assets/webfonts/montserrat-500.ttf',
  'assets/webfonts/montserrat-600.ttf',
  'assets/webfonts/montserrat-700.ttf',
  'images/favicon.png',
  'images/gdcoc_logo_bg.png',
  'images/gdcoc_logo_en.png',
];

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync(path.join(here, 'site'), out, { recursive: true });

for (const f of files) {
  const src = path.join(root, f);
  if (!existsSync(src)) throw new Error(`missing ${f}; run "node ../build.mjs" first`);
  mkdirSync(path.dirname(path.join(out, f)), { recursive: true });
  cpSync(src, path.join(out, f));
}
console.log(`public/ ready (${files.length + 2} files)`);
