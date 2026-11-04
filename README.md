# Release Radar

A small web app for exploring upcoming video game releases month by month:
the most hyped (or best rated / most reviewed) games as a bubble chart, a release calendar,
filters (platform, genre, theme, mode, company, engine, keyword, status), search, and a detail
panel with cover art, summary and a link to the trailer. Light and dark themes.

It is a static site: open `index.html` or serve the folder with any static host
(it is published with GitHub Pages).

## Data
- Game data and cover art: [IGDB.com](https://www.igdb.com). Trailers link to YouTube.
- `src/igdb-data.js` is a **snapshot** (top 300 games per month by hype), not live data.
  It is generated from the `IGDB API` Tableau datasource extract with
  `build_data.py` (kept with the Tableau version of this app).

## Files
- `index.html` – page shell
- `src/app.js` – the app (no framework)
- `src/styles.css` – glass UI theme
- `src/d3-hierarchy.min.js` – d3-hierarchy 3.1.2 (ISC licence), used for circle packing
- `src/igdb-data.js` – data snapshot
