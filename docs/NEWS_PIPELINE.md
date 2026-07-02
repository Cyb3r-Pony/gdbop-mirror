# News pipeline (technical)

News is **data-driven**. Do not hand-edit the generated HTML.

- **Source of truth:** `content/news/*.json` (one file per news item). Edited via Pages CMS (`.pages.yml`).
- **Templates:** `templates/news-article.bg.html`, `templates/news-article.en.html` (placeholders: `{{TITLE}} {{DESC}} {{SLUG}} {{BREADCRUMB}} {{H1}} {{ARTICLE}}`).
- **Build script:** `scripts/build_news.py` — regenerates `novini/<slug>.html`, `en/novini/<slug>.html`, and the homepage news cards (between the `<!-- NEWS:START -->` / `<!-- NEWS:END -->` markers in `index.html` and `en/index.html`), sorted by date.
- **Automation:** `.github/workflows/build-news.yml` runs the build on any change under `content/news/**` and commits the regenerated pages. GitHub Pages then serves them.

Run locally: `pip install markdown && python scripts/build_news.py`
