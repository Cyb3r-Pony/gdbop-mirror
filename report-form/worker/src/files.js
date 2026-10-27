// Attachment rules shared by the form (instant feedback) and the Worker
// (authoritative). The type is identified by the file's own bytes, never by
// its name or the Content-Type the client claims.
//
// Every file is uploaded on its own (PUT /api/upload/...) and streamed straight
// into R2, so the Worker never buffers or parses a large body (Workers Free has
// a 10 ms CPU budget per request).
const MB = 1024 * 1024;

export const FILE_TYPES = {
  png: { ext: 'png', mime: 'image/png', group: 'image', maxBytes: 10 * MB, label: 'PNG' },
  jpg: { ext: 'jpg', mime: 'image/jpeg', group: 'image', maxBytes: 10 * MB, label: 'JPG' },
  webp: { ext: 'webp', mime: 'image/webp', group: 'image', maxBytes: 10 * MB, label: 'WebP' },
  pdf: { ext: 'pdf', mime: 'application/pdf', group: 'pdf', maxBytes: 20 * MB, label: 'PDF' },
  eml: { ext: 'eml', mime: 'message/rfc822', group: 'mail', maxBytes: 20 * MB, label: 'EML' },
  msg: { ext: 'msg', mime: 'application/vnd.ms-outlook', group: 'mail', maxBytes: 20 * MB, label: 'MSG' },
};
export const KINDS = Object.keys(FILE_TYPES);

export const FILE_LIMITS = {
  maxFiles: 10,
  maxTotalBytes: 50 * MB,
  // bytes read from the start of a file to identify it (enough for e-mail headers)
  sniffBytes: 16 * 1024,
  maxNameLength: 120,
};

// What the <input type="file" accept> offers.
export const ACCEPT = 'image/png,image/jpeg,image/webp,application/pdf,.pdf,message/rfc822,.eml,application/vnd.ms-outlook,.msg';

const startsWith = (b, sig, at = 0) => sig.every((v, i) => b[at + i] === v);

const OLE2 = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
// "__substg1.0_" in UTF-16LE: the stream names every Outlook .msg file contains
const MSG_MARK = Array.from('__substg1.0_').flatMap((c) => [c.charCodeAt(0), 0]);

const indexOf = (bytes, needle, limit = bytes.length) => {
  const end = Math.min(bytes.length, limit) - needle.length;
  outer: for (let i = 0; i <= end; i++) {
    for (let j = 0; j < needle.length; j++) if (bytes[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
};

const MAIL_HEADERS = /^(received|return-path|from|to|subject|date|message-id|mime-version|delivered-to|x-[a-z0-9-]+|dkim-signature|arc-[a-z-]+|authentication-results|content-type|reply-to|sender|cc):/im;

// An .eml is plain text that starts with RFC 5322 header lines. Accepts it only
// if the first block is header-shaped and has at least two typical headers.
const looksLikeEml = (bytes) => {
  const n = Math.min(bytes.length, FILE_LIMITS.sniffBytes);
  if (n < 32) return false;
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(0, n));
  } catch {
    return false;
  }
  if (/[\u0000-\u0008\u000e-\u001f]/.test(text.slice(0, 2048))) return false; // binary
  const head = text.replace(/^﻿/, '').split(/\r?\n\r?\n/)[0];
  const lines = head.split(/\r?\n/).filter((l) => l && !/^[ \t]/.test(l));
  if (!lines.length || !/^[A-Za-z0-9-]+:/.test(lines[0])) return false;
  const known = new Set(lines.filter((l) => MAIL_HEADERS.test(l)).map((l) => l.split(':')[0].toLowerCase()));
  return known.size >= 2 && (known.has('from') || known.has('received') || known.has('return-path') || known.has('message-id'));
};

// Returns one of KINDS from the leading bytes, or '' if it is none of them.
export const detectFileType = (bytes) => {
  if (!bytes || bytes.length < 12) return '';
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png';
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'jpg';
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)) return 'webp';
  // "%PDF-" at the start (the spec allows it within the first 1024 bytes)
  const pdfAt = indexOf(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d], 1024);
  if (pdfAt !== -1) return 'pdf';
  if (startsWith(bytes, OLE2)) return indexOf(bytes, MSG_MARK) !== -1 ? 'msg' : 'msg?';
  if (looksLikeEml(bytes)) return 'eml';
  return '';
};

// The stream names of an Outlook .msg can sit beyond the first 16 KB, so an OLE2
// file is accepted as "msg?" from its head and confirmed by the scanner, which
// sees the whole file. Callers treat "msg?" as matching a declared "msg".
export const matchesKind = (detected, declared) => detected === declared || (declared === 'msg' && detected === 'msg?');

// Original file name as typed by the reporter, reduced to something harmless
// for a plain-text email: no control/bidi characters, no path, limited charset.
export const cleanFileName = (name) => {
  if (typeof name !== 'string') return '';
  let s = name.normalize('NFKC').replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g, '');
  s = s.split(/[\\/]/).pop() || '';
  s = s.replace(/[^\p{L}\p{N} ._()\-–,+&@#]/gu, '_').replace(/\s+/g, ' ').trim();
  if (s.length > FILE_LIMITS.maxNameLength) {
    const dot = s.lastIndexOf('.');
    const ext = dot > 0 && s.length - dot <= 6 ? s.slice(dot) : '';
    s = s.slice(0, FILE_LIMITS.maxNameLength - ext.length) + ext;
  }
  return s;
};

// Checks the manifest the form sends with the report: [{ kind, size, name }].
// Returns { files } (cleaned) or { error }.
export const checkManifest = (raw) => {
  if (raw === undefined || raw === null) return { files: [] };
  if (!Array.isArray(raw)) return { error: 'bad_request' };
  if (raw.length > FILE_LIMITS.maxFiles) return { error: 'too_many' };
  let total = 0;
  const files = [];
  for (const f of raw) {
    if (!f || typeof f !== 'object') return { error: 'bad_request' };
    const t = FILE_TYPES[f.kind];
    if (!t) return { error: 'bad_type' };
    if (!Number.isSafeInteger(f.size) || f.size <= 0) return { error: 'bad_type' };
    if (f.size > t.maxBytes) return { error: 'too_large' };
    total += f.size;
    files.push({ kind: f.kind, size: f.size, origName: cleanFileName(f.name) });
  }
  if (total > FILE_LIMITS.maxTotalBytes) return { error: 'total_too_large' };
  return { files };
};

// Reference number shown to the reporter, e.g. MVR-GDBOP-20261025-42KMX
// (the same string is the report id in the R2 keys below).
export const REPORT_ID_PREFIX = 'MVR-GDBOP';
export const REPORT_ID_RE = new RegExp(`^${REPORT_ID_PREFIX}-\\d{8}-[A-Z2-9]{5}$`);

// Storage layout in the R2 bucket:
//   pending/<id>.json      report waiting for its files (deleted when it is sent)
//   meta/<id>.json         file list of a sent report, no personal data
//   quarantine/<id>/<name> just uploaded, never served
//   clean/<id>/<name>      scanned (images re-encoded), served via signed links
//   rejected/<id>/<name>   original bytes of a refused file, kept as evidence, never served
//   results/<id>.json      scan results written by the GitHub Action
// name = "<uuid>.<ext>"
export const FILE_NAME_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(?:png|jpg|webp|pdf|eml|msg)$/;
export const keyFor = (stage, id, name) => `${stage}/${id}/${name}`;
export const extOf = (name) => name.slice(name.lastIndexOf('.') + 1);
