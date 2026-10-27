"""Run: python3 -m unittest discover -s .github/scripts -p "test_scan_uploads.py"  (needs Pillow; ClamAV optional)"""
import contextlib
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
import urllib.error

sys.path.insert(0, os.path.dirname(__file__))
import scan_uploads as su  # noqa: E402
from PIL import Image  # noqa: E402

RID = "MVR-GDBOP-20261025-ABCDE"
U = ["0b9c1f06-2f4e-4f5e-9a57-8f3f2f9c1a1%d" % i for i in range(10)]

# Fake ClamAV: anything containing the marker is "infected"; --version prints a banner.
FAKE_SCANNER = r'''
import os, sys
if "--version" in sys.argv:
    print("ClamAV 9.9.9/12345/Fake"); sys.exit(0)
if os.environ.get("FAKE_SCAN_FAIL"): sys.exit(2)
root = sys.argv[-1]; hit = False
for d, _, names in os.walk(root):
    for n in names:
        p = os.path.join(d, n)
        if b"X5O-FAKE-EICAR" in open(p, "rb").read():
            print(p + ": Fake.Test.Signature FOUND"); hit = True
sys.exit(1 if hit else 0)
'''


def png_bytes(size=(8, 6), text=None):
    from PIL import PngImagePlugin

    info = PngImagePlugin.PngInfo()
    if text:
        info.add_text("secret", text)
    out = io.BytesIO()
    Image.new("RGB", size, (200, 30, 30)).save(out, "PNG", pnginfo=info)
    return out.getvalue()


def jpg_with_exif():
    im = Image.new("RGB", (10, 10), (10, 120, 10))
    exif = Image.Exif()
    exif[0x010F] = "SecretCameraMaker"
    out = io.BytesIO()
    im.save(out, "JPEG", exif=exif)
    return out.getvalue()


PDF = b"%PDF-1.7\n1 0 obj << /Type /Catalog /OpenAction 2 0 R /Names << /#4aavaScript 3 0 R >> >> endobj\ntrailer\n%%EOF\n"
PLAIN_PDF = b"%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer\n%%EOF\n"
EML = (
    b"Return-Path: <x@bank-secure.example>\r\nReceived: from mx.example\r\n"
    b"From: \"Bank\" <noreply@bank-secure.example>\r\nTo: victim@example.com\r\n"
    b"Subject: =?utf-8?b?0J/RgNC+0LLQtdGA0LrQsA==?=\r\nDate: Mon, 26 Oct 2026 10:00:00 +0200\r\n"
    b"Message-ID: <1@x>\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=B\r\n\r\n"
    b"--B\r\nContent-Type: text/plain\r\n\r\nLogin at https://bank-secure.example/login and https://t.ly/abc\r\n"
    b"--B\r\nContent-Type: application/zip\r\nContent-Disposition: attachment; filename=\"invoice.zip\"\r\n"
    b"Content-Transfer-Encoding: base64\r\n\r\nUEsDBAoAAAAAAA==\r\n--B--\r\n"
)
OLE = b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1"
MSG = OLE + b"\0" * 1000 + "__substg1.0_0037001F".encode("utf-16-le") + b"\0" * 100
DOC = OLE + b"\0" * 2000


class FakeResp:
    def __init__(self, body, status=200):
        self.body, self.status = body, status

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def read(self, *a):
        return self.body


def vt_opener(table, calls):
    """table: sha256 -> stats dict | 404 | 429."""

    def opener(req, timeout=None):
        sha = req.full_url.rsplit("/", 1)[1]
        calls.append((req.full_url, req.get_method(), req.data))
        r = table.get(sha, 404)
        if isinstance(r, int):
            raise urllib.error.HTTPError(req.full_url, r, "x", {}, io.BytesIO(b""))
        return FakeResp(json.dumps({"data": {"attributes": {"last_analysis_stats": r}}}).encode())

    return opener


class Base(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.store = su.DirStore(self.dir)
        self.sdir = tempfile.mkdtemp()
        self.scanner = os.path.join(self.sdir, "fake_scan.py")
        with open(self.scanner, "w") as fh:
            fh.write(FAKE_SCANNER)
        self.cmd = f"{sys.executable} {self.scanner}"
        self.notified = []

    def tearDown(self):
        shutil.rmtree(self.dir)
        shutil.rmtree(self.sdir)

    def report(self, files, rid=RID, pending=False):
        """files: list of (ext, bytes). Writes quarantine + meta like the Worker does."""
        meta = {"id": rid, "crimeType": "phishing", "files": [], "scanMailed": False}
        for i, (ext, data) in enumerate(files):
            name = f"{U[i]}.{ext}"
            self.store.put(f"quarantine/{rid}/{name}", data, "x")
            meta["files"].append({"name": name, "kind": ext, "size": len(data), "arrived": True})
        self.store.put(f"meta/{rid}.json", json.dumps(meta).encode(), "x")
        if pending:
            self.store.put(f"pending/{rid}.json", b"{}", "x")
        return meta

    def run_scan(self, vt_key=None, vt_table=None, vt_calls=None, ok=True, **kw):
        calls = vt_calls if vt_calls is not None else []

        def notify_fn(url, secret, rid):
            self.notified.append(rid)
            return ok

        return su.process(self.store, self.cmd, vt_key, sleep=lambda s: None, worker_url="https://w.example",
                          secret="s", vt_opener=vt_opener(vt_table or {}, calls), notify_fn=notify_fn, **kw)

    def keys(self, prefix):
        return sorted(k for k, _ in self.store.list(prefix))

    def results(self, rid=RID):
        return json.loads(self.store.get(f"results/{rid}.json"))


class Detect(unittest.TestCase):
    def test_kinds(self):
        self.assertEqual(su.detect(png_bytes()), "png")
        self.assertEqual(su.detect(jpg_with_exif()), "jpg")
        self.assertEqual(su.detect(PDF), "pdf")
        self.assertEqual(su.detect(EML), "eml")
        self.assertEqual(su.detect(MSG), "msg")
        self.assertEqual(su.detect(DOC), "ole")
        for bad in (b"GIF89a" + b"\0" * 20, b"MZ\x90\0" + b"\0" * 20, b"just text, no headers at all here\n", b"<html>Subject: x</html>"):
            self.assertEqual(su.detect(bad), "")

    def test_pdf_flags_decode_name_escapes(self):
        self.assertEqual(su.pdf_flags(PDF), ["javascript", "openaction"])
        self.assertEqual(su.pdf_flags(PLAIN_PDF), [])

    def test_mail_info(self):
        info = su.mail_info(EML)
        self.assertEqual(info["subject"], "Проверка")
        self.assertIn("bank-secure.example", info["from"])
        self.assertEqual(info["urlCount"], 2)
        self.assertEqual(len(info["attachments"]), 1)
        self.assertEqual(info["attachments"][0]["name"], "invoice.zip")
        self.assertEqual(len(info["attachments"][0]["sha256"]), 64)

    def test_reencode_strips_metadata(self):
        out = su.reencode(jpg_with_exif(), "jpg")
        self.assertNotIn(b"SecretCameraMaker", out)
        out = su.reencode(png_bytes(text="TOPSECRET") + b"<?php evil ?>", "png")
        self.assertNotIn(b"TOPSECRET", out)
        self.assertNotIn(b"evil", out)


class Process(Base):
    def test_clean_report_all_kinds(self):
        self.report([("png", png_bytes(text="SECRET")), ("pdf", PDF), ("eml", EML), ("msg", MSG)])
        counts = self.run_scan()
        self.assertEqual(counts["clean"], 4)
        self.assertEqual(self.keys("quarantine/"), [])
        self.assertEqual(len(self.keys(f"clean/{RID}/")), 4)
        self.assertNotIn(b"SECRET", self.store.get(f"clean/{RID}/{U[0]}.png"))  # re-encoded
        self.assertEqual(self.store.get(f"clean/{RID}/{U[1]}.pdf"), PDF)  # unchanged
        r = self.results()
        self.assertTrue(r["complete"])
        self.assertTrue(r["notified"])
        self.assertEqual(self.notified, [RID])
        self.assertEqual(r["clamavVersion"], "ClamAV 9.9.9/12345/Fake")
        by = {f["name"]: f for f in r["files"]}
        self.assertEqual(by[f"{U[1]}.pdf"]["pdfFlags"], ["javascript", "openaction"])
        self.assertEqual(by[f"{U[2]}.eml"]["mail"]["attachments"][0]["name"], "invoice.zip")
        self.assertNotIn("_data", json.dumps(r))
        for f in r["files"]:
            self.assertEqual(f["verdict"], "clean")
            self.assertEqual(len(f["sha256"]), 64)
            self.assertEqual(f["vt"], {"status": "skipped"})

    def test_infected_rejected_original_kept_as_evidence(self):
        bad = PLAIN_PDF + b"X5O-FAKE-EICAR"
        self.report([("pdf", bad), ("png", png_bytes())])
        self.run_scan()
        self.assertEqual(self.store.get(f"rejected/{RID}/{U[0]}.pdf"), bad)
        self.assertEqual(self.keys(f"clean/{RID}/"), [f"clean/{RID}/{U[1]}.png"])
        f = {x["name"]: x for x in self.results()["files"]}[f"{U[0]}.pdf"]
        self.assertEqual((f["verdict"], f["reason"], f["clamav"], f["signature"]), ("rejected", "infected", "infected", "Fake.Test.Signature"))

    def test_type_checks(self):
        self.report([("msg", DOC), ("pdf", png_bytes()), ("eml", b"not an email at all, sorry\n" * 3)])
        self.run_scan()
        reasons = {x["name"].split(".")[1]: x["reason"] for x in self.results()["files"]}
        self.assertEqual(reasons, {"msg": "not_msg", "pdf": "invalid", "eml": "invalid"})
        self.assertEqual(self.keys("clean/"), [])

    def test_open_upload_and_unknown_reports_are_left_alone(self):
        self.report([("png", png_bytes())], pending=True)
        self.store.put(f"quarantine/MVR-GDBOP-20261025-ZZZZZ/{U[0]}.png", png_bytes(), "x")  # no meta yet
        self.run_scan()
        self.assertEqual(len(self.keys("quarantine/")), 2)
        self.assertEqual(self.notified, [])

    def test_unexpected_keys_are_dropped(self):
        self.store.put(f"quarantine/{RID}/evil.exe", b"MZ", "x")
        self.store.put("quarantine/whatever.txt", b"x", "x")
        self.assertEqual(self.run_scan()["ignored"], 2)
        self.assertEqual(self.keys("quarantine/"), [])

    def test_scanner_failure_keeps_files_and_reports_nothing(self):
        self.report([("png", png_bytes())])
        os.environ["FAKE_SCAN_FAIL"] = "1"
        try:
            counts = self.run_scan()
        finally:
            del os.environ["FAKE_SCAN_FAIL"]
        self.assertEqual(counts["errors"], 1)
        self.assertEqual(len(self.keys("quarantine/")), 1)
        self.assertEqual(self.notified, [])
        # next run works: released and reported
        self.run_scan()
        self.assertEqual(self.notified, [RID])

    def test_failed_callback_is_retried_next_run_and_only_once_after(self):
        self.report([("png", png_bytes())])
        counts = self.run_scan(ok=False)
        self.assertEqual(counts["errors"], 1)
        self.assertFalse(self.results()["notified"])
        self.run_scan()
        self.assertTrue(self.results()["notified"])
        self.run_scan()
        self.assertEqual(self.notified, [RID, RID])

    def test_virustotal_verdicts(self):
        good, evil, att = png_bytes(), PLAIN_PDF, su.mail_info(EML)["attachments"][0]["sha256"]
        import hashlib
        h = lambda b: hashlib.sha256(b).hexdigest()  # noqa: E731
        table = {
            h(good): {"malicious": 1, "suspicious": 0, "undetected": 60, "harmless": 0},  # one engine: not enough
            h(evil): {"malicious": 20, "suspicious": 1, "undetected": 40, "harmless": 0},
            att: {"malicious": 9, "undetected": 50},
        }
        calls = []
        self.report([("png", good), ("pdf", evil), ("eml", EML)])
        self.run_scan(vt_key="k", vt_table=table, vt_calls=calls)
        by = {x["name"].split(".")[1]: x for x in self.results()["files"]}
        self.assertEqual(by["png"]["verdict"], "clean")
        self.assertEqual(by["png"]["vt"], {"status": "found", "malicious": 1, "suspicious": 0, "total": 61})
        self.assertEqual((by["pdf"]["verdict"], by["pdf"]["reason"]), ("rejected", "vt_malicious"))
        self.assertEqual((by["eml"]["verdict"], by["eml"]["reason"]), ("rejected", "vt_malicious"))  # its attachment
        self.assertEqual(by["eml"]["vt"], {"status": "unknown"})
        # only hashes went out, as GETs without a body
        self.assertTrue(all(m == "GET" and d is None and len(u.rsplit("/", 1)[1]) == 64 for u, m, d in calls))

    def test_virustotal_quota_stops_lookups(self):
        import hashlib
        a, b = png_bytes((3, 3)), png_bytes((4, 4))
        calls = []
        self.report([("png", a), ("png", b)])
        self.run_scan(vt_key="k", vt_table={hashlib.sha256(a).hexdigest(): 429}, vt_calls=calls)
        self.assertEqual(len(calls), 1)
        self.assertTrue(all(f["vt"]["status"] == "skipped" for f in self.results()["files"]))
        self.assertEqual(len(self.keys("clean/")), 2)

    def test_silent(self):
        self.report([("png", png_bytes()), ("pdf", PLAIN_PDF + b"X5O-FAKE-EICAR")])
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            self.run_scan()
        self.assertEqual(out.getvalue() + err.getvalue(), "")

    def test_cli_local_mode_prints_nothing(self):
        self.report([("png", png_bytes())])
        env = {**os.environ, "SCAN_CMD": self.cmd}
        p = subprocess.run([sys.executable, su.__file__, "--local", self.dir], capture_output=True, env=env)
        self.assertEqual((p.returncode, p.stdout, p.stderr), (0, b"", b""))
        p = subprocess.run([sys.executable, su.__file__, "--local", "/nonexistent/dir/x"], capture_output=True, env=env)
        self.assertEqual(p.stdout + p.stderr, b"")


@unittest.skipUnless(shutil.which("clamscan"), "ClamAV not installed")
class RealClamAV(Base):
    def test_eicar_inside_an_email_attachment(self):
        eicar = b"X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*"
        import base64
        mail = EML.replace(b"UEsDBAoAAAAAAA==", base64.b64encode(eicar))
        self.report([("eml", mail)])
        su.process(self.store, "clamscan", None, worker_url=None, secret=None)
        self.assertEqual(self.results()["files"][0]["reason"], "infected")


if __name__ == "__main__":
    unittest.main()
