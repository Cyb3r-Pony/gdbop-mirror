// build.mjs — compiles the form (src/report.jsx -> assets/js/dist/report.bundle.js)
// and the Tailwind CSS ahead of time, so the page needs no inline scripts or styles
// and can run under a strict Content-Security-Policy.
//
// Usage: npm ci && node build.mjs   (worker/'s `npm run deploy` calls it for you)
import * as esbuild from 'esbuild';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// React / ReactDOM / lucide-react are vendored (assets/js/*.js, esm.sh builds)
// instead of pulled from npm at build time: one reviewed copy, no new supply chain.
const alias = {
  react: path.resolve(__dirname, 'assets/js/react.js'),
  'react-dom/client': path.resolve(__dirname, 'assets/js/react-dom.js'),
  'lucide-react': path.resolve(__dirname, 'assets/js/lucide-react.js'),
};

await esbuild.build({
  absWorkingDir: __dirname,
  entryPoints: ['src/report.jsx'],
  outfile: 'assets/js/dist/report.bundle.js',
  bundle: true,
  minify: true,
  sourcemap: false,
  format: 'iife',
  target: ['es2019'],
  // Classic transform: the vendored React build has no react/jsx-runtime entry.
  jsx: 'transform',
  jsxFactory: 'React.createElement',
  jsxFragment: 'React.Fragment',
  loader: { '.jsx': 'jsx' },
  alias,
  legalComments: 'none',
  logLevel: 'info',
});

execSync('npx tailwindcss -i ./src/tailwind.css -o ./assets/css/tailwind.min.css --minify', {
  stdio: 'inherit',
  cwd: __dirname,
});
console.log('Build complete.');
