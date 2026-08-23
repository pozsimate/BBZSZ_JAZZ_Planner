# Bartók JAZZ Planner 2026

A browser-based timetable builder for the Bartók Konzi jazz department.

**Live:** https://pozsimate.github.io/BBZSZ_JAZZ_Planner/

This repository is a refactor of the original single-file `index.html` app into a small, Cursor-friendly project while preserving the original UI, scheduling logic and embedded seed database.

## Project structure

```text
bartok-jazz-planner/
├── index.html
├── src/
│   ├── app.js
│   └── styles.css
├── public/
│   └── seed-data.json
├── package.json
├── .gitignore
└── README.md
```

## Run locally

The app loads `public/seed-data.json` with `fetch()`, so open it through a local HTTP server rather than by double-clicking `index.html`.

### Option 1 — Node

```bash
npm install
npm run dev
```

Then open the local URL printed by Vite.

### Option 2 — Python

```bash
python3 -m http.server 5173
```

Then open:

```text
http://localhost:5173
```

## Data persistence

The app keeps edits in the current browser tab unless you export them as JSON. It also contains the original Supabase cloud database connection controls.

## Notes for Cursor

Open the repository folder itself, not just `index.html`:

```bash
cursor bartok-jazz-planner
```

The main application logic is in `src/app.js`; styles are in `src/styles.css`; the initial database is in `public/seed-data.json`.
