#!/usr/bin/env python3
"""
Scans the report attachments held in the private R2 bucket and releases or
rejects them. Fails closed: nothing reaches clean/ unless it was scanned.

For every file of a sent report (meta/<id>.json exists, pending/<id>.json does not):
  - type check from the bytes (PNG/JPG/WebP/PDF/EML/MSG) and size limit
  - SHA-256 + MD5
  - ClamAV (mail and PDF parsing on: an .eml/.msg is scanned with its attachments)
  - VirusTotal lookup by SHA-256 only (the file itself is never uploaded); for an
    .eml also each attachment's SHA-256
  - PDF: flags risky features (JavaScript, OpenAction, Launch, embedded files...)
  - images are re-encoded from raw pixels (no EXIF/GPS, no trailing data);
    PDF/EML/MSG are released unchanged
  - released -> clean/<id>/<name>; refused -> rejected/<id>/<name> (original
    bytes kept as evidence, never served)
Then results/<id>.json is written and the Worker is told to send the scan email.

Silent on purpose. This repository is public, and so are its Actions logs and
run history, so the script prints nothing about files, counts or errors. The
exit code is the only signal (0 = fine, 1 = something needs a look).

Usage:
  scan_uploads.py            process the bucket
  scan_uploads.py --local D  same, against a local directory (tests; no callback)

Environment:
  R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET
  R2_JURISDICTION   "eu" for a bucket created in the EU jurisdiction (optional)
  SCAN_CMD          scanner command, default "clamscan" (exit 0 clean, 1 infected, else error)
  VT_API_KEY        optional: VirusTotal hash lookups
  WORKER_URL        e.g. https://report.example.bg (the scan email is sent from there)
  SCAN_CALLBACK_SECRET  bearer secret shared with the Worker
"""
import email
import email.policy
import hashlib
import io
import json
import os
import re
import shlex
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

MB = 1024 * 1024
MAX_BYTES = {"png": 10 * MB, "jpg": 10 * MB, "webp": 10 * MB, "pdf": 20 * MB, "eml": 20 * MB, "msg": 20 * MB}
CHUNK = 60  # files per scanner run (bounds disk/memory; one signature load per chunk)
WORKERS = 6  # parallel downloads / re-encodes / uploads
GIVE_UP_AFTER = 6 * 3600  # a file the scanner keeps failing on is reported as "no result" after this

# VirusTotal, hash lookups only. The free public API allows 4 lookups a minute and
# 500 a day; this is an extra signal on top of ClamAV, so any failure (quota,
# network) simply means "not checked" and never blocks a release on its own.
VT_URL = "https://www.virustotal.com/api/v3/files/"
VT_INTERVAL = 15.5  # seconds between lookups (4 per minute)
VT_MAX_PER_RUN = 40  # keeps one run well inside the job timeout
VT_MIN_DETECTIONS = 2  # engines that must call it malicious (avoids single-engine false positives)
MAX_PIXELS = 40_000_000

ID_RE = r"MVR-GDBOP-\d{8}-[A-Z2-9]{5}"
KEY_RE = re.compile(
    rf"^quarantine/({ID_RE})/"
    r"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.(png|jpg|webp|pdf|eml|msg)$"
)
RESULTS_RE = re.compile(rf"^results/({ID_RE})\.json$")
FORMATS = {"png": "PNG", "jpg": "JPEG", "webp": "WEBP"}
MIME = {
    "png": "image/png", "jpg": "image/jpeg", "webp": "image/webp",
    "pdf": "application/pdf", "eml": "message/rfc822", "msg": "application/vnd.ms-outlook",
}
OLE2 = b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1"
MSG_MARK = "__substg1.0_".encode("utf-16-le")
MAIL_HEADER_RE = re.compile(
    rb"^(received|return-path|from|to|subject|date|message-id|mime-version|delivered-to|x-[a-z0-9-]+|"
    rb"dkim-signature|arc-[a-z-]+|authentication-results|content-type|reply-to|sender|cc):",
    re.I,
)
URL_RE = re.compile(r"\bhttps?://[^\s<>\"')\]]+", re.I)


def now_iso():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def looks_like_eml(data: bytes) -> bool:
    head = data[:16384]
    if re.search(rb"[\x00-\x08\x0e-\x1f]", head[:2048]):
        return False
    head = head.lstrip(b"\xef\xbb\xbf")
    block = re.split(rb"\r?\n\r?\n", head, maxsplit=1)[0]
    lines = [l for l in re.split(rb"\r?\n", block) if l and l[:1] not in (b" ", b"\t")]
    if not lines or not re.match(rb"^[A-Za-z0-9-]+:", lines[0]):
        return False
    known = {l.split(b":", 1)[0].lower() for l in lines if MAIL_HEADER_RE.match(l)}
    return len(known) >= 2 and bool(known & {b"from", b"received", b"return-path", b"message-id"})


def detect(data: bytes) -> str:
    """File type from the content ('' if not one of the accepted kinds)."""
    if len(data) < 12:
        return ""
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return "png"
    if data[:3] == b"\xff\xd8\xff":
        return "jpg"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "webp"
    if b"%PDF-" in data[:1024]:
        return "pdf"
    if data[:8] == OLE2:
        return "msg" if MSG_MARK in data else "ole"
    if looks_like_eml(data):
        return "eml"
    return ""


def reencode(data: bytes, kind: str) -> bytes:
    """Decode and rebuild the image from raw pixels so no metadata or trailing data survives."""
    from PIL import Image, ImageOps

    Image.MAX_IMAGE_PIXELS = MAX_PIXELS
    with Image.open(io.BytesIO(data), formats=[FORMATS[kind]]) as im:
        if im.width * im.height > MAX_PIXELS:
            raise ValueError("too many pixels")
        im.load()
        im = ImageOps.exif_transpose(im)  # honour rotation, then forget the EXIF
        has_alpha = "A" in im.getbands() or im.info.get("transparency") is not None
        mode = "RGBA" if has_alpha and kind != "jpg" else "RGB"
        im = im.convert(mode)
        fresh = Image.frombytes(mode, im.size, im.tobytes())
    out = io.BytesIO()
    if kind == "png":
        fresh.save(out, "PNG", optimize=True)
    elif kind == "jpg":
        fresh.save(out, "JPEG", quality=90, optimize=True)
    else:
        fresh.save(out, "WEBP", quality=90)
    return out.getvalue()


PDF_PATTERNS = {
    "javascript": rb"/(?:JavaScript|JS)\b",
    "openaction": rb"/(?:OpenAction|AA)\b",
    "launch": rb"/Launch\b",
    "embedded": rb"/(?:EmbeddedFile|EmbeddedFiles)\b",
    "xfa": rb"/XFA\b",
    "uri": rb"/URI\b",
    "encrypted": rb"/Encrypt\b",
}


def pdf_flags(data: bytes):
    """pdfid-style keyword check; '#xx' escapes in names are decoded first."""
    norm = re.sub(rb"#([0-9A-Fa-f]{2})", lambda m: bytes([int(m.group(1), 16)]), data)
    return [k for k, pat in PDF_PATTERNS.items() if re.search(pat, norm)]


def _clip(s, n=300):
    s = re.sub(r"[\x00-\x1f\x7f​-‏‪-‮⁦-⁩]", " ", str(s or ""))
    return re.sub(r"\s+", " ", s).strip()[:n]


def mail_info(data: bytes):
    """Subject/From/Date, attachments (name, size, SHA-256) and the number of links of an .eml."""
    msg = email.message_from_bytes(data, policy=email.policy.default)
    atts, urls = [], set()
    for part in msg.walk():
        if part.is_multipart():
            continue
        disp = (part.get_content_disposition() or "").lower()
        name = part.get_filename()
        payload = part.get_payload(decode=True) or b""
        if disp == "attachment" or name:
            atts.append({
                "name": _clip(name or "", 120),
                "size": len(payload),
                "sha256": hashlib.sha256(payload).hexdigest(),
                "_data": payload,
            })
        elif part.get_content_maintype() == "text":
            try:
                text = payload.decode(part.get_content_charset() or "utf-8", "replace")
            except LookupError:
                text = payload.decode("utf-8", "replace")
            urls.update(URL_RE.findall(text))
        if len(atts) >= 20:
            break
    return {
        "subject": _clip(msg.get("Subject", "")),
        "from": _clip(msg.get("From", ""), 200),
        "date": _clip(msg.get("Date", ""), 60),
        "attachments": atts,
        "urlCount": len(urls),
    }


def scan_batch(blobs, scan_cmd):
    """Scan many files with ONE scanner process (the signature database is loaded once).

    `blobs` maps a caller key to bytes; returns key -> (verdict, signature) with
    verdict 'clean' | 'infected' | 'error'. Files get random names in a temp dir.
    Exit code 0 = all clean, 1 = infected (named in the output; if none can be
    matched, every file in the batch is treated as infected), else error for all.
    """
    if not blobs:
        return {}
    with tempfile.TemporaryDirectory() as tmp:
        names = {}
        for key, data in blobs.items():
            name = uuid.uuid4().hex + ".bin"
            names[name] = key
            with open(os.path.join(tmp, name), "wb") as fh:
                fh.write(data)
        try:
            proc = subprocess.run(
                [*shlex.split(scan_cmd), "-r", "--no-summary", "--scan-mail=yes", "--scan-pdf=yes",
                 "--scan-ole2=yes", "--scan-archive=yes", tmp],
                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=1200, text=True, errors="replace",
            )
        except (OSError, subprocess.TimeoutExpired):
            return {key: ("error", "") for key in blobs}
    if proc.returncode == 0:
        return {key: ("clean", "") for key in blobs}
    if proc.returncode == 1:
        found = {}
        for line in proc.stdout.splitlines():
            if line.endswith(" FOUND") and ": " in line:
                path, sig = line[: -len(" FOUND")].rsplit(": ", 1)
                found[os.path.basename(path)] = _clip(sig, 120)
        hits = {names[n]: sig for n, sig in found.items() if n in names}
        if not hits:
            return {key: ("infected", "") for key in blobs}
        return {key: (("infected", hits[key]) if key in hits else ("clean", "")) for key in blobs}
    return {key: ("error", "") for key in blobs}


def clamav_version(scan_cmd):
    try:
        out = subprocess.run([*shlex.split(scan_cmd), "--version"], stdout=subprocess.PIPE,
                             stderr=subprocess.DEVNULL, timeout=120, text=True).stdout
        return _clip(out, 80)
    except Exception:
        return ""


class S3Store:
    def __init__(self):
        import boto3
        from botocore.config import Config

        self.bucket = os.environ["R2_BUCKET"]
        jur = os.environ.get("R2_JURISDICTION", "").strip()
        host = f"{os.environ['R2_ACCOUNT_ID']}.{jur + '.' if jur else ''}r2.cloudflarestorage.com"
        self.s3 = boto3.client(
            "s3",
            endpoint_url=f"https://{host}",
            aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"],
            aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"],
            region_name="auto",
            config=Config(signature_version="s3v4", retries={"max_attempts": 3}),
        )

    def list(self, prefix):
        """Yields (key, last_modified_epoch)."""
        for page in self.s3.get_paginator("list_objects_v2").paginate(Bucket=self.bucket, Prefix=prefix):
            for obj in page.get("Contents", []):
                yield obj["Key"], obj["LastModified"].timestamp()

    def exists(self, key):
        try:
            self.s3.head_object(Bucket=self.bucket, Key=key)
            return True
        except self.s3.exceptions.ClientError:
            return False

    def get(self, key):
        return self.s3.get_object(Bucket=self.bucket, Key=key)["Body"].read()

    def put(self, key, body, content_type):
        self.s3.put_object(Bucket=self.bucket, Key=key, Body=body, ContentType=content_type)

    def delete(self, key):
        self.s3.delete_object(Bucket=self.bucket, Key=key)


class DirStore:
    """Same interface over a directory, for tests."""

    def __init__(self, root):
        self.root = root

    def _p(self, key):
        return os.path.join(self.root, *key.split("/"))

    def list(self, prefix):
        for dirpath, _, names in os.walk(self.root):
            for n in names:
                full = os.path.join(dirpath, n)
                key = os.path.relpath(full, self.root).replace(os.sep, "/")
                if key.startswith(prefix):
                    yield key, os.path.getmtime(full)

    def exists(self, key):
        return os.path.exists(self._p(key))

    def get(self, key):
        with open(self._p(key), "rb") as fh:
            return fh.read()

    def put(self, key, body, content_type):
        os.makedirs(os.path.dirname(self._p(key)), exist_ok=True)
        with open(self._p(key), "wb") as fh:
            fh.write(body if isinstance(body, bytes) else body.encode())

    def delete(self, key):
        os.remove(self._p(key))


class VirusTotal:
    """Hash lookups with the free-API pacing; stops asking after quota/auth errors."""

    def __init__(self, api_key, sleep=time.sleep, opener=urllib.request.urlopen):
        self.key = api_key
        self.sleep = sleep
        self.opener = opener
        self.count = 0
        self.stopped = not api_key
        self.cache = {}

    def lookup(self, sha256):
        if sha256 in self.cache:
            return self.cache[sha256]
        if self.stopped or self.count >= VT_MAX_PER_RUN:
            return {"status": "skipped"}
        if self.count:
            self.sleep(VT_INTERVAL)
        self.count += 1
        req = urllib.request.Request(VT_URL + sha256, headers={"x-apikey": self.key, "accept": "application/json"})
        try:
            with self.opener(req, timeout=20) as resp:
                info = json.load(resp)
        except urllib.error.HTTPError as err:
            code = err.code
            err.close()
            if code == 404:
                res = {"status": "unknown"}
                self.cache[sha256] = res
                return res
            if code in (401, 403, 429):
                self.stopped = True
                return {"status": "skipped"}
            return {"status": "error"}
        except Exception:
            return {"status": "error"}
        stats = ((info.get("data") or {}).get("attributes") or {}).get("last_analysis_stats") or {}

        def n(k):
            try:
                return int(stats.get(k, 0) or 0)
            except (TypeError, ValueError):
                return 0

        total = sum(n(k) for k in ("malicious", "suspicious", "undetected", "harmless"))
        res = {"status": "found", "malicious": n("malicious"), "suspicious": n("suspicious"), "total": total}
        self.cache[sha256] = res
        return res


def vt_bad(v):
    return bool(v) and v.get("status") == "found" and v.get("malicious", 0) >= VT_MIN_DETECTIONS


def _chunks(items, n):
    for i in range(0, len(items), n):
        yield items[i : i + n]


def _load_json(store, key):
    try:
        return json.loads(store.get(key))
    except Exception:
        return None


def notify(worker_url, secret, report_id, opener=urllib.request.urlopen):
    """Asks the Worker to send the scan email. True on success."""
    if not worker_url or not secret:
        return False
    req = urllib.request.Request(
        worker_url.rstrip("/") + "/api/scan-result",
        data=json.dumps({"id": report_id}).encode(),
        headers={"Authorization": f"Bearer {secret}", "Content-Type": "application/json", "User-Agent": "scan-uploads"},
        method="POST",
    )
    try:
        with opener(req, timeout=30) as resp:
            return 200 <= resp.status < 300
    except urllib.error.HTTPError as err:
        err.close()
        return False
    except Exception:
        return False


def process(store, scan_cmd="clamscan", vt_key=None, sleep=time.sleep, now=time.time,
            worker_url=None, secret=None, vt_opener=urllib.request.urlopen, notify_fn=notify):
    counts = {"clean": 0, "rejected": 0, "ignored": 0, "errors": 0, "notified": 0}
    vt = VirusTotal(vt_key, sleep, vt_opener)
    version = None

    # group quarantined files by report; leave reports whose upload is still open
    by_report, ages = {}, {}
    for key, mtime in list(store.list("quarantine/")):
        m = KEY_RE.match(key)
        if not m:  # the Worker never writes such keys
            store.delete(key)
            counts["ignored"] += 1
            continue
        rid, stem, ext = m.groups()
        by_report.setdefault(rid, []).append((key, rid, f"{stem}.{ext}", ext))
        ages[key] = mtime
    for rid in list(by_report):
        if store.exists(f"pending/{rid}.json") or not store.exists(f"meta/{rid}.json"):
            del by_report[rid]

    pending = [item for items in by_report.values() for item in items]
    results = {}  # rid -> {name: result}

    def record(item, res):
        results.setdefault(item[1], {})[item[2]] = {"name": item[2], **res}

    def reject(item, data, reason, res):
        key, rid, name, _ = item
        store.put(f"rejected/{rid}/{name}", data if data is not None else reason.encode(), "application/octet-stream")
        store.delete(key)
        record(item, {**res, "verdict": "rejected", "reason": reason})
        counts["rejected"] += 1

    def fetch(item):
        try:
            return store.get(item[0])
        except Exception:
            return None

    def release(args):
        item, data, res = args
        key, rid, name, ext = item
        try:
            out = reencode(data, ext) if ext in FORMATS else data
        except Exception:
            return item, data, res, False
        store.put(f"clean/{rid}/{name}", out, MIME[ext])
        store.delete(key)
        return item, data, res, True

    with ThreadPoolExecutor(WORKERS) as pool:
        for chunk in _chunks(pending, CHUNK):
            blobs = {}
            for item, data in zip(chunk, pool.map(fetch, chunk)):
                if data is None:  # vanished or unreadable: try again next run
                    counts["errors"] += 1
                    continue
                base = {"size": len(data), "sha256": hashlib.sha256(data).hexdigest(), "md5": hashlib.md5(data).hexdigest()}
                kind = detect(data)
                if len(data) > MAX_BYTES[item[3]]:
                    reject(item, data, "too_large", base)
                elif item[3] == "msg" and kind == "ole":
                    reject(item, data, "not_msg", base)
                elif kind != item[3]:
                    reject(item, data, "invalid", base)
                else:
                    blobs[item[0]] = (item, data, base)
            if blobs and version is None:
                version = clamav_version(scan_cmd)
            verdicts = scan_batch({k: v[1] for k, v in blobs.items()}, scan_cmd)
            to_release = []
            for key, (item, data, base) in blobs.items():
                verdict, sig = verdicts[key]
                res = {**base, "clamav": verdict}
                if sig:
                    res["signature"] = sig
                if verdict == "error":
                    counts["errors"] += 1  # stays in quarantine, retried next run
                    if now() - ages.get(key, now()) > GIVE_UP_AFTER:
                        record(item, {**res, "verdict": "error"})
                    continue
                # second opinion: hash lookup of the original file (and of an email's attachments)
                res["vt"] = vt.lookup(base["sha256"])
                if item[3] == "pdf":
                    res["pdfFlags"] = pdf_flags(data)
                if item[3] == "eml":
                    try:
                        info = mail_info(data)
                    except Exception:
                        info = None
                    if info:
                        for a in info["attachments"]:
                            a.pop("_data", None)
                            a["vt"] = vt.lookup(a["sha256"])
                        res["mail"] = info
                att_bad = any(vt_bad(a.get("vt")) for a in (res.get("mail") or {}).get("attachments", []))
                if verdict == "infected":
                    reject(item, data, "infected", res)
                elif vt_bad(res["vt"]) or att_bad:
                    reject(item, data, "vt_malicious", res)
                else:
                    to_release.append((item, data, res))
            for item, data, res, ok in pool.map(release, to_release):
                if ok:
                    record(item, {**res, "verdict": "clean"})
                    counts["clean"] += 1
                else:
                    reject(item, data, "invalid", res)

    # merge into results/<id>.json; a report is complete once every file that
    # arrived has a result. Then the Worker sends the scan email.
    touched = set(results)
    for key, _ in list(store.list("results/")):
        m = RESULTS_RE.match(key)
        if m:
            touched.add(m.group(1))
    for rid in sorted(touched):
        doc = _load_json(store, f"results/{rid}.json") or {"id": rid, "files": [], "notified": False}
        if doc.get("notified"):
            continue
        merged = {f["name"]: f for f in doc.get("files", [])}
        merged.update(results.get(rid, {}))
        meta = _load_json(store, f"meta/{rid}.json") or {}
        expected = [f["name"] for f in meta.get("files", []) if f.get("arrived")]
        complete = bool(expected) and all(n in merged for n in expected)
        doc.update({
            "files": [merged[n] for n in expected if n in merged] or list(merged.values()),
            "complete": complete,
            "scannedAt": now_iso(),
            "clamavVersion": version or doc.get("clamavVersion", ""),
        })
        store.put(f"results/{rid}.json", json.dumps(doc, ensure_ascii=False).encode(), "application/json")
        if complete and notify_fn(worker_url, secret, rid):
            doc["notified"] = True
            store.put(f"results/{rid}.json", json.dumps(doc, ensure_ascii=False).encode(), "application/json")
            counts["notified"] += 1
        elif complete and worker_url:
            counts["errors"] += 1  # retried next run
    return counts


def main(argv):
    local = argv[argv.index("--local") + 1] if "--local" in argv else None
    store = DirStore(local) if local else S3Store()
    counts = process(
        store,
        os.environ.get("SCAN_CMD", "clamscan"),
        os.environ.get("VT_API_KEY") or None,
        worker_url=None if local else os.environ.get("WORKER_URL"),
        secret=None if local else os.environ.get("SCAN_CALLBACK_SECRET"),
    )
    return 1 if counts["errors"] else 0


if __name__ == "__main__":
    try:
        code = main(sys.argv[1:])
    except BaseException:
        # No traceback or message: a library error could echo bucket or object
        # names into a public log. The failed run itself is the signal.
        code = 1
    sys.exit(code)
