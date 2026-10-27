-- Links between reports: the perpetrator identifiers found in each report
-- (kept with no time limit) and the reporter's name, phone and email (kept only
-- for REPORTER_RETENTION_DAYS, as keyed HMACs for matching plus one AES-GCM
-- sealed copy for display). The report text itself is never stored: the email
-- stays the record of the report.
--
-- Apply with: npx wrangler d1 migrations apply report-intel --remote

CREATE TABLE reports (
  id TEXT PRIMARY KEY,                 -- MVR-GDBOP-YYYYMMDD-XXXXX
  received_at TEXT NOT NULL,           -- ISO 8601, UTC
  crime_type TEXT NOT NULL,
  reporter_purged_at TEXT              -- set when the reporter's data was deleted by retention
);
CREATE INDEX reports_received ON reports (received_at);

-- HMAC-SHA256(INTEL_HMAC_KEY, kind + "\n" + normalised value); kind is name, phone or email.
CREATE TABLE reporter_keys (
  report_id TEXT NOT NULL REFERENCES reports (id),
  kind TEXT NOT NULL,
  mac TEXT NOT NULL,
  PRIMARY KEY (report_id, kind)
);
CREATE INDEX reporter_keys_mac ON reporter_keys (kind, mac);

-- AES-256-GCM(INTEL_ENC_KEY) of {"fullName","phone","email"}, bound to the report id.
CREATE TABLE reporter_data (
  report_id TEXT PRIMARY KEY REFERENCES reports (id),
  sealed TEXT NOT NULL
);

-- kind: domain, url, email, phone, iban, crypto, handle. value is normalised.
CREATE TABLE indicators (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,
  value TEXT NOT NULL,
  UNIQUE (kind, value)
);

CREATE TABLE report_indicators (
  report_id TEXT NOT NULL REFERENCES reports (id),
  indicator_id INTEGER NOT NULL REFERENCES indicators (id),
  PRIMARY KEY (report_id, indicator_id)
);
CREATE INDEX report_indicators_indicator ON report_indicators (indicator_id);

-- Who searched for what (scripts/intel.mjs). Reporter searches store the HMAC, not the value.
CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY,
  at TEXT NOT NULL,
  who TEXT NOT NULL,                    -- local user@host that ran the script
  action TEXT NOT NULL,
  query TEXT NOT NULL
);
CREATE INDEX audit_log_at ON audit_log (at);
