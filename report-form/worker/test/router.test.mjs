import { test } from 'node:test';
import assert from 'node:assert/strict';
import { route } from '../src/router.js';

const ORIGIN = 'https://example.bg';

const setup = (extra = {}) => {
  const seen = [];
  const env = {
    ALLOWED_ORIGINS: ORIGIN,
    ASSETS: { fetch: async (req) => { seen.push(new URL(req.url).pathname); return new Response('asset', { status: 200 }); } },
    ...extra,
  };
  return { env, seen, deps: {} };
};
const get = (path, init) => new Request(`${ORIGIN}${path}`, init);

test('maintenance on: page, assets and API all answer 503 and nothing reaches ASSETS', async () => {
  const { env, seen, deps } = setup({ MAINTENANCE: 'true' });
  for (const [path, init] of [
    ['/'],
    ['/index.html'],
    ['/assets/js/dist/report.bundle.js'],
    ['/api/report', { method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'application/json' }, body: '{}' }],
    ['/api/report', { method: 'OPTIONS', headers: { Origin: ORIGIN } }],
    ['/anything/else'],
  ]) {
    const res = await route(get(path, init), env, deps);
    assert.equal(res.status, 503, path);
    assert.equal(res.headers.get('Retry-After'), '3600');
    assert.equal(res.headers.get('Cache-Control'), 'no-store');
    assert.equal(res.headers.get('X-Robots-Tag'), 'noindex');
    assert.match(await res.text(), /временно не е достъпна/);
  }
  assert.deepEqual(seen, []);
});

test('maintenance on: signed file links still reach the handler (not the 503 page)', async () => {
  const { env, deps } = setup({ MAINTENANCE: 'true' });
  const res = await route(get('/api/file/MVR-GDBOP-20261025-ABCDE/0b9c1f06-2f4e-4f5e-9a57-8f3f2f9c1a11.png'), env, deps);
  assert.equal(res.status, 404); // handler's answer without bindings/secrets, not 503
});

test('maintenance off or unset: assets go to ASSETS, API goes to the handler', async () => {
  for (const MAINTENANCE of ['false', undefined, '', 'TRUE', 'yes']) {
    const { env, seen, deps } = setup(MAINTENANCE === undefined ? {} : { MAINTENANCE });
    const page = await route(get('/'), env, deps);
    assert.equal(page.status, 200, String(MAINTENANCE));
    assert.equal(await page.text(), 'asset');
    assert.deepEqual(seen, ['/']);
    const api = await route(get('/api/report', { method: 'POST', headers: { Origin: 'https://evil.example' } }), env, deps);
    assert.equal(api.status, 403); // handler ran (origin check)
  }
});
