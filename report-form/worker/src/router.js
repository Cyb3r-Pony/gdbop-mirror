// Top-level routing for the Worker, free of Worker-only imports so it can be
// unit-tested in plain Node (index.js injects `EmailMessage`).
//
// MAINTENANCE = "true" (see wrangler.toml) hides the whole site, form and API
// included, behind a plain 503 while it is being built. Signed download links
// (/api/file/...) keep working so a reviewer holding one is not cut off.
import { handleRequest } from './handler.js';

const maintenance = () =>
  new Response('Формата за сигнали временно не е достъпна.\nThe report form is temporarily unavailable.\n', {
    status: 503,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Retry-After': '3600',
      'Cache-Control': 'no-store',
      'X-Robots-Tag': 'noindex',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'",
    },
  });

export const route = (request, env, deps) => {
  const { pathname } = new URL(request.url);
  // signed download links and the scanner's callback keep working in maintenance mode
  if (env.MAINTENANCE === 'true' && !pathname.startsWith('/api/file/') && pathname !== '/api/scan-result') return maintenance();
  if (pathname.startsWith('/api/')) return handleRequest(request, env, deps);
  return env.ASSETS.fetch(request);
};
