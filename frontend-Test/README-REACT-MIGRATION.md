# Mkass React migration — frontend-Test

This folder replaces the old single-file `frontend-Test/index.html` with a Vite + React frontend.

## What changed

- `index.html` is now the Vite entry file.
- React source lives in `src/`.
- Icons, manifest, and the existing `sw.js` are in `public/`.
- The previous working single HTML file is preserved at:
  - `legacy/index-legacy-before-react.html`

## Backend API

By default the React app uses the Test backend:

```txt
https://mkass-backend-test.up.railway.app/api
```

Override it on Vercel with:

```txt
VITE_API_URL=https://mkass-backend-test.up.railway.app/api
```

## Vercel Test settings

Change the Test Vercel project settings from static HTML to Vite:

```txt
Root Directory: frontend-Test
Framework Preset: Vite
Build Command: npm run build
Output Directory: dist
Install Command: npm install
```

## Local test

```bash
cd frontend-Test
npm install
npm run dev
npm run build
```

## Notes

- Backend was not changed.
- The map/address click now builds Google Maps directions from latitude/longitude first, then coordinates in the map link, then the saved Google Maps link, then address fallback.
- The settings save button shows `Sauvegarde...`, then `✓ Sauvegardé`, and also shows the toast `✓ Paramètres sauvegardés`.
- Starter salons see Pro areas locked; Pro salons can open Finance, Personnel and Règles.
