# Bartók Planner 2026

A browser-based timetable builder for the Bartók Conservatory.

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

## Public Reports + password gate

The live site opens on **Reports**. Other tabs stay locked until you unlock editing.

- Default password: `bartok2026`
- Header: **Unlock editing…** / **Lock editing**
- Soft lock only (password hash is in `src/app.js`) — not real security against someone who reads the JS

Change the password:

```bash
node -e "console.log(require('crypto').createHash('sha256').update('YOUR_PASSWORD','utf8').digest('hex'))"
```

Paste the hex into `EDITOR_PASSWORD_SHA256` in `src/app.js`.

## Data persistence

Edits stay in this browser (autosave) until you export them.

To put the same data on the **GitHub Pages** site:

1. Load Sheets / JSON / cloud in the Cloud database tab.
2. Click **published-state.json for GitHub**.
3. Commit the downloaded `published-state.json` next to `index.html` and push.

Visitors then open https://pozsimate.github.io/BBZSZ_JAZZ_Planner/ and the page fetches that file. A JSON load in the browser alone does not change GitHub.

The original Supabase cloud controls are still there for device-to-device working copies.

## Notes for Cursor

Open the repository folder itself, not just `index.html`:

```bash
cursor bartok-jazz-planner
```

The main application logic is in `src/app.js`; styles are in `src/styles.css`; the initial database is in `public/seed-data.json`.
