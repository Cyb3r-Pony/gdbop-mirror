// Public configuration for the report form, served at https://report.stop-the-scam.xyz (demo)
// (worker/ serves the page and the API from one origin, hence the relative
// apiUrl). `turnstileSiteKey` is public. While it is empty the form is off
// and the page says it is temporarily unavailable.
export const REPORT_CONFIG = {
    apiUrl: '/api/report',
    turnstileSiteKey: '',
    // Image attachments (needs the R2 bucket and the "Scan report uploads" workflow).
    filesEnabled: true,
};
export const REPORT_ENABLED = Boolean(REPORT_CONFIG.apiUrl && REPORT_CONFIG.turnstileSiteKey);
