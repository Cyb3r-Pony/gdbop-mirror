# ГДБОП Website — Roadmap to Launch

Reference document for all remaining work. Updated: 2026-06-13.

---

## Status snapshot

| Area | Status |
|---|---|
| Static HTML/CSS site (BG + EN) | ✅ Complete |
| Folder structure (`css/`, `js/`, `novini/`, `proekti/`) | ✅ Complete |
| Security hardening (`.htaccess`, CSP, meta tags, `rel=noopener noreferrer`) | ✅ Complete |
| Semantic work-card links (`<a>` instead of `onclick`) | ✅ Complete |
| Citizen contact form with file upload (BG + EN) | ✅ Complete — needs Web3Forms key |
| GitHub repository | ✅ Exists: `github.com/Cyb3r-Pony/gdbop-mirror` |
| Decap CMS (`admin/`) | ⏳ Not started |
| `news/` markdown articles | ⏳ Not started |
| Netlify Identity + git-gateway | ⏳ Not started |
| Bluehost deployment | ⏳ Not started |
| Old article migration (MySQL → Markdown) | ⏳ Not started |
| HSTS header | ⏳ Enable after SSL confirmed |

---

## Step 1 — Activate the contact form (Web3Forms)

**What:** The citizen tip/contact form on `kontakti.html` and `en/kontakti.html` is built and tested. It only needs a live API key.

**How:**
1. Go to [web3forms.com](https://web3forms.com) and create a free account
2. Enter the official ГДБОП email (`gdbop@mvr.bg` or whichever mailbox should receive citizen tips)
3. Confirm the email address — Web3Forms sends a verification link
4. Copy the **Access Key** from your dashboard
5. Open `kontakti.html` and `en/kontakti.html`, find this line in each:
   ```html
   <input type="hidden" name="access_key" value="YOUR_ACCESS_KEY">
   ```
   Replace `YOUR_ACCESS_KEY` with your actual key
6. Commit and push, then upload to Bluehost

**Form capabilities (already built):**
- Fields: first name, middle name, family name, email, phone (optional), subject dropdown, message
- File upload: drag-and-drop, up to 10 files, 5 MB each, 15 MB total
- Accepted formats: JPG, PNG, PDF, DOC, DOCX, XLS, XLSX, PPT, PPTX, TXT, ZIP
- Honeypot anti-spam field (invisible to users)
- GDPR consent checkbox
- Loading spinner + success/error messages in Bulgarian and English

**Free tier:** 250 submissions/month. Upgrade at web3forms.com if higher volume is needed.

**Alternative:** If you prefer EmailJS, switch to their Professional plan ($15/month) which supports attachments. The form HTML is identical — only the JS submission block needs to change.

---

## Step 2 — Push to GitHub

The commit is ready locally. Run this once from the project folder:

```bash
cd /Users/melon433/Downloads/gdbop
git push --set-upstream origin main
```

If you're prompted for credentials, use your GitHub username and a **Personal Access Token** (not your password). Generate one at: GitHub → Settings → Developer settings → Personal access tokens → Tokens (classic) → Generate new token (scope: `repo`).

---

## Step 3 — Set up Netlify Identity + git-gateway

**Why:** Decap CMS (the editor interface for news and leadership) uses Netlify Identity for login and git-gateway to write back to the GitHub repo. The site stays hosted on Bluehost — Netlify only handles authentication.

**How:**
1. Go to [app.netlify.com](https://app.netlify.com) → New site → Import from GitHub → select `Cyb3r-Pony/gdbop-mirror`
2. Do **not** set a build command or publish directory — the site will not be served from Netlify
3. In Site settings → Identity → Enable Identity
4. In Site settings → Identity → Services → Enable Git Gateway
5. In Identity → Registration → set to **Invite only** (so random people cannot register)
6. Copy the **Netlify site URL** (e.g. `https://quirky-name-123.netlify.app`) — you need it for `admin/config.yml`

---

## Step 4 — Build the Decap CMS admin interface

**What:** Create two files in the `admin/` folder (already exists as an empty stub).

**File 1 — `admin/index.html`:**
```html
<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>ГДБОП — Административен панел</title>
  <script src="https://identity.netlify.com/v1/netlify-identity-widget.js"></script>
</head>
<body>
  <script src="https://unpkg.com/decap-cms@^3.0.0/dist/decap-cms.js"></script>
</body>
</html>
```

**File 2 — `admin/config.yml`:**
```yaml
backend:
  name: git-gateway
  branch: main

site_url: https://gdcoc.bg
display_url: https://gdcoc.bg

media_folder: "images/uploads"
public_folder: "/images/uploads"

collections:

  - name: "news"
    label: "Новини"
    folder: "news"
    create: true
    slug: "{{year}}-{{month}}-{{day}}-{{slug}}"
    fields:
      - { label: "Заглавие", name: "title", widget: "string" }
      - { label: "Дата", name: "date", widget: "datetime" }
      - { label: "Снимка", name: "image", widget: "image", required: false }
      - { label: "Текст", name: "body", widget: "markdown" }

  - name: "leadership"
    label: "Ръководство"
    folder: "_data/leadership"
    create: true
    fields:
      - { label: "Три имена", name: "name", widget: "string" }
      - { label: "Длъжност", name: "position", widget: "string" }
      - { label: "Снимка", name: "photo", widget: "image", required: false }

  - name: "contacts"
    label: "Контактна информация"
    folder: "_data/contacts"
    create: false
    fields:
      - { label: "Телефон", name: "phone", widget: "string" }
      - { label: "Имейл", name: "email", widget: "string" }
      - { label: "Адрес", name: "address", widget: "string" }
```

Also add this snippet to `index.html` just before `</head>` so the Netlify Identity widget works from the homepage:
```html
<script>
  if (window.netlifyIdentity) {
    window.netlifyIdentity.on("init", user => {
      if (!user) {
        window.netlifyIdentity.on("login", () => { document.location.href = "/admin/"; });
      }
    });
  }
</script>
<script src="https://identity.netlify.com/v1/netlify-identity-widget.js"></script>
```

---

## Step 5 — Make the news grid dynamic

**What:** The news cards on `index.html` are currently hardcoded. For the CMS to work end-to-end, the grid needs to load from the `news/` markdown files automatically.

**How:** Add a lightweight JavaScript loader to `index.html` that fetches `news/*.md` files and renders the grid. Claude can write this in one session — bring up the topic when ready.

The news article HTML pages in `novini/` can stay for the two existing articles. All new articles published via Decap CMS will live in `news/` as markdown and render through the JS loader.

---

## Step 6 — Set up auto-deploy from GitHub to Bluehost

**What:** When an editor publishes an article via Decap CMS, it commits to GitHub. Without a deploy pipeline, those changes never reach Bluehost.

**How:** Create a GitHub Actions workflow that FTPs the changed files to Bluehost on every push to `main`.

**File to create: `.github/workflows/deploy.yml`**
```yaml
name: Deploy to Bluehost

on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: FTP Deploy
        uses: SamKirkland/FTP-Deploy-Action@v4.3.5
        with:
          server: ${{ secrets.FTP_SERVER }}
          username: ${{ secrets.FTP_USERNAME }}
          password: ${{ secrets.FTP_PASSWORD }}
          server-dir: /public_html/
          exclude: |
            **/.git*
            **/.git*/**
            ROADMAP.md
```

**Then in GitHub → repository → Settings → Secrets and variables → Actions, add:**
- `FTP_SERVER` — your Bluehost FTP host (e.g. `ftp.gdcoc.bg`)
- `FTP_USERNAME` — your Bluehost FTP username
- `FTP_PASSWORD` — your Bluehost FTP password

After this, every `git push` (by a developer) or CMS publish (by an editor) automatically updates the live site within ~1 minute.

---

## Step 7 — Invite editors and enforce 2FA

**What:** Give access to editors who will publish news and update leadership info.

**How:**
1. In Netlify → Identity → Invite users → enter editor email addresses
2. Each editor receives an email, sets a password, then goes to their Netlify User Settings → Security → Two-Factor Authentication → scans a QR code with Google Authenticator or Authy
3. On Netlify Pro plan: enforce 2FA organisation-wide (any editor without 2FA is blocked from the CMS)

**Editor workflow after setup:**
- Open `gdcoc.bg/admin`
- Log in with email + password + 6-digit TOTP code
- Write article in visual editor → click Publish
- GitHub commit is created automatically → GitHub Action deploys to Bluehost

---

## Step 8 — Upload to Bluehost and point the domain

**How:**
1. Log in to Bluehost → File Manager → `public_html/`
2. Upload all project files (or let the GitHub Action handle it after Step 6 is set up)
3. Confirm SSL is active: Bluehost → Domains → SSL/TLS → Let's Encrypt → verify green padlock
4. Once SSL is confirmed working, uncomment the HSTS line in `.htaccess`:
   ```
   Header always set Strict-Transport-Security "max-age=31536000; includeSubDomains"
   ```
5. Point domain DNS to Bluehost nameservers if not already done

---

## Step 9 — Migrate old articles from gdbop.bg (MySQL)

**What:** The old `gdbop.bg` news articles are in a MySQL database. They need to become `.md` files in `news/`.

**How:**
1. Log in to the old host → phpMyAdmin → export the news table as CSV
2. Run the conversion script (Claude will generate the final version once you have the export):
   ```python
   import csv, os, re
   from datetime import datetime

   with open('news_export.csv', encoding='utf-8') as f:
       reader = csv.DictReader(f)
       for row in reader:
           date = row['date'][:10]
           slug = re.sub(r'[^\w-]', '-', row['title'][:50].lower())
           filename = f"news/{date}-{slug}.md"
           content = f"""---
   title: "{row['title']}"
   date: {date}T00:00:00.000Z
   image: {row.get('image_path', '')}
   ---

   {row['body']}
   """
           with open(filename, 'w', encoding='utf-8') as out:
               out.write(content)
   ```
3. Upload the generated `news/` folder to Bluehost (or commit to GitHub)

---

## Security checklist before launch

- [ ] Web3Forms key inserted in `kontakti.html` and `en/kontakti.html`
- [ ] SSL certificate active on Bluehost (Let's Encrypt)
- [ ] HSTS line uncommented in `.htaccess` after SSL confirmed
- [ ] Netlify Identity set to **Invite only**
- [ ] All editor accounts have 2FA enabled
- [ ] GitHub repo is **private** (or confirm public is acceptable for a government static site)
- [ ] FTP credentials stored only in GitHub Secrets, not in any file

---

## Folder structure reference

```
public_html/
├── index.html              ← BG homepage
├── za-gdbop.html           ← About (history, leadership, legislation, projects)
├── kontakti.html           ← Contacts + citizen tip form ✅
├── linii-na-rabota.html    ← Lines of work
├── video.html              ← Video gallery
├── .htaccess               ← Security headers, HTTPS redirect, caching ✅
├── css/
│   └── sub.css             ← Shared styles for all subpages ✅
├── js/
│   └── sub.js              ← Shared JS for all subpages ✅
├── images/                 ← Site images
│   └── uploads/            ← CMS-uploaded images (created by Decap CMS)
├── novini/                 ← News article HTML pages (existing articles) ✅
├── proekti/                ← Project sub-pages ✅
├── news/                   ← Markdown news articles (CMS output) ⏳
├── admin/
│   ├── index.html          ← Decap CMS loader ⏳
│   └── config.yml          ← CMS configuration ⏳
└── en/                     ← English mirror (same structure) ✅
    ├── kontakti.html       ← EN contacts + tip form ✅
    ├── novini/
    ├── proekti/
    └── ...
```
