// HMAC-signed, expiring links. Each link is a bearer secret for exactly one
// action on one object until it expires. The purpose is part of the signed
// message, so an upload link can never be replayed as a download link (or the
// other way round).
//   file:     GET  /api/file/<id>/<name>      download a scanned file (7 days)
//   upload:   PUT  /api/upload/<id>/<name>    upload one declared file (1 hour)
//   finalize: POST /api/finalize/<id>         "all files are up, send it" (1 hour)
const enc = new TextEncoder();

const b64url = (buf) =>
  btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64url = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

const key = (secret) => crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
const message = (purpose, id, name, exp) => enc.encode(`${purpose}:${id}/${name}.${exp}`);

export const LINK_TTL_SECONDS = 7 * 24 * 3600;
export const UPLOAD_TTL_SECONDS = 3600;

export const sign = async (secret, purpose, id, name, exp) =>
  b64url(await crypto.subtle.sign('HMAC', await key(secret), message(purpose, id, name, exp)));

export const verify = async (secret, purpose, id, name, exp, sig) => {
  try {
    return await crypto.subtle.verify('HMAC', await key(secret), fromB64url(sig), message(purpose, id, name, exp));
  } catch {
    return false;
  }
};

export const signFile = (secret, id, name, exp) => sign(secret, 'file', id, name, exp);
export const verifyFile = (secret, id, name, exp, sig) => verify(secret, 'file', id, name, exp, sig);

// Constant-time comparison of two strings (for the scanner's bearer secret).
export const safeEqual = async (a, b) => {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  const [ha, hb] = await Promise.all([a, b].map((s) => crypto.subtle.digest('SHA-256', enc.encode(s))));
  const x = new Uint8Array(ha);
  const y = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
};
