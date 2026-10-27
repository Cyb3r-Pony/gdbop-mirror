import { EmailMessage } from 'cloudflare:email';
import { route } from './router.js';
import { purgeExpired } from './intel.js';
import { sendStalePending } from './handler.js';

// The form (static files in ./public, served by the ASSETS binding) and its API
// live on one origin. `run_worker_first = true` in wrangler.toml sends every
// request through here so MAINTENANCE can cover the whole site; the router then
// forwards /api/* to the handler and the rest to ASSETS.
// The Cron Trigger (wrangler.toml) sends reports whose upload was abandoned and
// deletes reporter data past its retention term (links between reports).
export default {
  fetch: (request, env) => route(request, env, { EmailMessage }),
  scheduled: (controller, env, ctx) =>
    ctx.waitUntil(Promise.allSettled([
      sendStalePending(env, { EmailMessage, fetchFn: fetch, now: () => new Date() }),
      purgeExpired(env),
    ])),
};
