// Input validation + content scanning for the report form.
//
// Runs in the Worker (authoritative) and in the browser (same file, bundled
// into the site) so the user gets instant feedback with identical rules.
// Returns machine-readable error codes only; the UI maps them to text.
import { CRIME_TYPES, CHANNELS, CURRENCIES, EVIDENCE, LIMITS, ids } from './schema.js';

// --- text normalisation ----------------------------------------------------

// C0/C1 controls (except \t \n), zero-width chars and bidi overrides/isolates
// (used for "RTLO" filename/URL spoofing and to hide text from reviewers).
const INVISIBLE = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F​-‏‪-‮⁠-⁩﻿]/g;

const clean = (v, { multiline = false } = {}) => {
  if (typeof v !== 'string') return '';
  let s = v.normalize('NFC').replace(/\r\n?/g, '\n').replace(INVISIBLE, '');
  s = multiline ? s.replace(/[ \t]+\n/g, '\n').replace(/\n{4,}/g, '\n\n\n') : s.replace(/\s+/g, ' ');
  return s.trim();
};

// --- injection / markup scanning -------------------------------------------

// There is no database and no shell behind this form; the data only ends up in
// a plain-text email. These checks are defence in depth and noise filtering:
// reject anything that looks like markup, script, or an attack payload rather
// than a victim's description.
const DANGEROUS = [
  /<\s*\/?\s*[a-z!?][^>]*>/i, // HTML / XML tags, comments, doctype
  /<\s*\/?\s*[a-z]+\s*$/i, // unterminated tag at end of text
  /\b(?:javascript|vbscript)\s*:/i, // script URI schemes
  /\bdata\s*:\s*(?:text|application)\//i, // data: URIs carrying code
  /\bfile\s*:\/\//i,
  /\bon[a-z]{3,20}\s*=\s*["'`]?[^\s]/i, // inline event handlers (onerror=...)
  /\{\{|\}\}|\$\{|<%|%>/, // template-injection tokens
  /(?:\bunion\s+(?:all\s+)?select\b|\bdrop\s+table\b|\binsert\s+into\b|'\s*or\s*'?1'?\s*=\s*'?1|;\s*--)/i, // SQLi probes
  /(?:;|\|\||&&|`|\$\()\s*(?:rm|curl|wget|bash|sh|nc|powershell|cmd)\b/i, // shell metacharacter chains
  /\.\.[\\/]\.\.[\\/]/, // path traversal
];

export const looksDangerous = (s) => DANGEROUS.some((re) => re.test(s));

// --- link analysis ---------------------------------------------------------

const SHORTENERS = new Set([
  'bit.ly', 'tinyurl.com', 't.co', 'goo.gl', 'is.gd', 'cutt.ly', 'rb.gy',
  'ow.ly', 't.ly', 'shorturl.at', 'buff.ly', 'rebrand.ly', 'tiny.cc',
]);
const RISKY_EXT = /\.(?:exe|scr|bat|cmd|com|msi|apk|jar|js|vbs|ps1|lnk|iso|img|dmg|docm|xlsm|hta|zip|rar|7z)$/i;
const RISKY_TLD = /\.(?:zip|mov|top|xyz|click|link|work|rest|country|gq|tk|ml|cf|ga)$/i;

// Parse a candidate URL leniently and report why it deserves attention. The
// links are never fetched; this is purely syntactic.
export const analyzeUrl = (raw) => {
  const flags = [];
  let parsed;
  try {
    parsed = new URL(/^[a-z]+:\/\//i.test(raw) ? raw : `http://${raw}`);
  } catch {
    return ['unparseable'];
  }
  const host = parsed.hostname.toLowerCase();
  if (parsed.username || parsed.password) flags.push('credentials-in-url');
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || /^\[.*\]$/.test(host) || /^(?:0x[0-9a-f]+|\d{8,10})$/i.test(host)) flags.push('ip-address-host');
  if (host.split('.').some((l) => l.startsWith('xn--'))) flags.push('punycode');
  if (SHORTENERS.has(host)) flags.push('url-shortener');
  if (RISKY_TLD.test(host)) flags.push('risky-tld');
  if (parsed.port && !['80', '443'].includes(parsed.port)) flags.push('non-standard-port');
  if (RISKY_EXT.test(parsed.pathname)) flags.push('executable-or-archive');
  if (raw.length > 300) flags.push('very-long');
  if (host.split('.').length > 5) flags.push('many-subdomains');
  return flags;
};

// "https://evil.example/x" -> "hxxps://evil[.]example/x", so mail clients and
// the reader's tooling never auto-link or prefetch a reported malicious URL.
export const defangUrl = (u) => {
  const m = u.match(/^([a-z]+:\/\/)?([^/?#]*)(.*)$/is);
  if (!m) return u.replace(/\./g, '[.]');
  const scheme = (m[1] || '').replace(/^http/i, 'hxxp').replace(/^ftp/i, 'fxp').replace('://', '[://]');
  return `${scheme}${m[2].replace(/\./g, '[.]')}${m[3]}`;
};

// The text is split on whitespace and every token is checked with anchored or
// single-class patterns, so the work grows linearly with the text. (The previous
// global patterns backtracked quadratically on crafted input like "a.a.a.…":
// ~36 ms for 5000 characters, more than a Free-plan Worker's CPU budget.)
const MAX_TOKEN = 2048;
const SCHEME_URL = /(?:https?|ftp):\/\/[^\s<>"'`]+/gi;
const LEAD = /^[(\["'«„]+/;
const TRAIL = /[.,;:!?)\]}"'»“]+$/;
const HOST_WITH_PATH = /^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,24}\//i; // bit.ly/abc
const DOT_BEFORE_TLD = /([a-z0-9-])\.(?=[a-z]{2})/gi; // evil.com, user@evil.com

export const scanText = (text) => {
  const urls = [];
  let n = 0;
  const note = (u) => {
    n += 1;
    if (urls.length < LIMITS.maxUrls) urls.push({ url: u, flags: analyzeUrl(u) });
  };
  const defangToken = (token) => {
    const lead = (token.match(LEAD) || [''])[0];
    const rest = token.slice(lead.length);
    const trail = (rest.match(TRAIL) || [''])[0];
    let core = rest.slice(0, rest.length - trail.length);
    const schemeLess = core.length <= MAX_TOKEN && !/^(?:https?|ftp):/i.test(core);
    if (schemeLess && (/^www\./i.test(core) || HOST_WITH_PATH.test(core))) {
      note(core);
      core = defangUrl(core);
    } else {
      core = core.replace(SCHEME_URL, (m) => {
        note(m);
        return defangUrl(m);
      });
    }
    // whatever still looks like host.tld (bare domains, e-mail domains) is defanged too
    return lead + core.replace(DOT_BEFORE_TLD, '$1[.]') + trail;
  };
  const defanged = text
    .split(/(\s+)/)
    .map((part) => (part && !/^\s/.test(part) ? defangToken(part) : part))
    .join('');
  return { defanged, urls, urlCount: n };
};

// --- ЕГН -------------------------------------------------------------------

export const validEgn = (s) => {
  if (!/^\d{10}$/.test(s)) return false;
  const d = s.split('').map(Number);
  let mm = d[2] * 10 + d[3];
  let year = d[0] * 10 + d[1];
  if (mm >= 41 && mm <= 52) { year += 2000; mm -= 40; }
  else if (mm >= 21 && mm <= 32) { year += 1800; mm -= 20; }
  else if (mm >= 1 && mm <= 12) { year += 1900; }
  else return false;
  const day = d[4] * 10 + d[5];
  const date = new Date(Date.UTC(year, mm - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== mm - 1 || date.getUTCDate() !== day) return false;
  if (date.getTime() > Date.now()) return false;
  const w = [2, 4, 8, 5, 10, 9, 7, 3, 6];
  const check = (w.reduce((acc, wi, i) => acc + wi * d[i], 0) % 11) % 10;
  return check === d[9];
};

// Date of birth, YYYY-MM-DD: a real calendar date, not before 1900, not in the future.
// (The English form asks for this instead of the ЕГН, which foreigners do not have.)
export const validDob = (s) => {
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  return (
    date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d &&
    y >= 1900 && date.getTime() <= Date.now()
  );
};

// --- phone / email ---------------------------------------------------------

// Bulgarian mobile (087/088/089, +359 87/88/89) or any E.164 number.
// Returns the normalised "+359..." form, or '' if invalid.
export const normalizePhone = (s) => {
  const t = s.replace(/[\s().-]/g, '');
  const bg = t.match(/^(?:\+359|00359|0)(8[7-9]\d{7})$/);
  if (bg) return `+359${bg[1]}`;
  const intl = t.match(/^(?:\+|00)([1-9]\d{7,14})$/);
  return intl ? `+${intl[1]}` : '';
};

const EMAIL_RE = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
export const validEmail = (s) =>
  s.length <= LIMITS.email && s.split('@')[0].length <= LIMITS.emailLocal && !s.includes('..') && EMAIL_RE.test(s);

// --- names -----------------------------------------------------------------

const NAME_PART = /^\p{L}[\p{L}'’-]*$/u;

// --- main ------------------------------------------------------------------

// Takes the untrusted request object, returns either the cleaned value (only
// known fields, all strings trimmed/normalised) or per-field error codes.
export const validateReport = (raw) => {
  const errors = {};
  const v = {};
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, errors: { _form: 'invalid' } };

  const str = (key, opts) => clean(raw[key], opts);
  const single = (key) => {
    const s = str(key);
    if (looksDangerous(s)) errors[key] = 'dangerous';
    return s;
  };

  // honeypot: real users never see or fill this
  v.honeypot = typeof raw.fax === 'string' && raw.fax.trim() !== '';

  v.crimeType = str('crimeType');
  if (!ids(CRIME_TYPES).includes(v.crimeType)) errors.crimeType = 'required';

  v.channel = str('channel');
  if (v.channel && !ids(CHANNELS).includes(v.channel)) errors.channel = 'invalid';

  v.incidentDate = str('incidentDate');
  if (v.incidentDate) {
    const m = v.incidentDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    const d = m && new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    const valid = d && d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
    if (!valid || +m[1] < 2000 || d.getTime() > Date.now() + 24 * 3600 * 1000) errors.incidentDate = 'invalid';
  }

  v.lossAmount = str('lossAmount');
  v.lossCurrency = str('lossCurrency');
  if (v.lossAmount) {
    if (!/^\d{1,12}(?:[.,]\d{1,2})?$/.test(v.lossAmount)) errors.lossAmount = 'invalid';
    if (!ids(CURRENCIES).includes(v.lossCurrency)) errors.lossCurrency = 'required';
  } else {
    v.lossCurrency = '';
  }

  v.suspect = single('suspect');
  if (v.suspect.length > LIMITS.suspect) errors.suspect = 'too_long';

  // already reported to an MVR unit? explicit yes/no is mandatory
  v.alreadyReported = str('alreadyReported');
  if (v.alreadyReported !== 'yes' && v.alreadyReported !== 'no') errors.alreadyReported = 'required';
  v.reportedTo = v.alreadyReported === 'yes' ? single('reportedTo') : '';
  if (v.alreadyReported === 'yes' && !errors.reportedTo) {
    if (v.reportedTo.length < LIMITS.reportedTo.min) errors.reportedTo = 'required';
    else if (v.reportedTo.length > LIMITS.reportedTo.max) errors.reportedTo = 'too_long';
  }

  v.fullName = single('fullName');
  if (!errors.fullName) {
    const parts = v.fullName.split(' ').filter(Boolean);
    const { nameParts, namePart, nameTotal } = LIMITS;
    if (parts.length < nameParts.min) errors.fullName = 'three_names';
    else if (parts.length > nameParts.max || v.fullName.length > nameTotal) errors.fullName = 'too_long';
    else if (!parts.every((p) => NAME_PART.test(p) && p.length >= namePart.min && p.length <= namePart.max)) errors.fullName = 'invalid';
  }

  // The person is identified by a ЕГН or, for foreigners (the English form), a date of
  // birth. One of the two is required; whichever is given is checked.
  v.egn = str('egn');
  v.dob = str('dob');
  if (v.egn) {
    if (!validEgn(v.egn)) errors.egn = 'invalid';
  } else if (v.dob) {
    if (!validDob(v.dob)) errors.dob = 'invalid';
  } else {
    errors.egn = 'required';
    errors.dob = 'required';
  }

  v.phone = normalizePhone(str('phone'));
  if (!v.phone) errors.phone = str('phone') ? 'invalid' : 'required';

  v.email = str('email').toLowerCase();
  if (!validEmail(v.email)) errors.email = v.email ? 'invalid' : 'required';

  v.content = str('content', { multiline: true });
  if (v.content.length < LIMITS.content.min) errors.content = v.content ? 'too_short' : 'required';
  else if (v.content.length > LIMITS.content.max) errors.content = 'too_long';
  else if (looksDangerous(v.content)) errors.content = 'dangerous';
  else {
    const scan = scanText(v.content);
    if (scan.urlCount > LIMITS.maxUrls) errors.content = 'too_many_links';
  }

  // optional checklist: only known ids, kept in canonical order, no duplicates
  v.evidence = [];
  if (raw.evidence !== undefined && raw.evidence !== null) {
    const ev = raw.evidence;
    if (!Array.isArray(ev) || ev.length > EVIDENCE.length || !ev.every((x) => typeof x === 'string' && ids(EVIDENCE).includes(x))) {
      errors.evidence = 'invalid';
    } else {
      v.evidence = ids(EVIDENCE).filter((id) => ev.includes(id));
    }
  }

  // explicit confirmations, each a literal `true`
  if (raw.notEmergency !== true) errors.notEmergency = 'required'; // confirmed before the form is shown
  if (raw.truthDeclaration !== true) errors.truthDeclaration = 'required'; // data is true; aware of liability
  if (raw.consent !== true) errors.consent = 'required';

  return Object.keys(errors).length ? { ok: false, errors, value: v } : { ok: true, errors: {}, value: v };
};
