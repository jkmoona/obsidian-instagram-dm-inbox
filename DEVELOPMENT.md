# Development

## Build

```bash
npm install
npm run build
```

Produces `main.js`. The deployable plugin folder is `manifest.json` + `main.js` + `styles.css`.

## Auto-install into your vault

`cp .env.example .env.local` and set `OBSIDIAN_VAULT_PATH` to your vault. Then `npm run dev` (watch) or `npm run build` (one-shot) writes `main.js` + `manifest.json` + `styles.css` directly into `<vault>/.obsidian/plugins/instagram-dm-inbox/`. Reload Obsidian (`Cmd/Ctrl+P → Reload app without saving`) to see changes. Delete `.env.local` for CI / release builds.

Only those three files are touched — your plugin settings (`data.json`, which holds the server URL and API key) survive across rebuilds, so you don't have to re-connect Instagram after each edit.

## Manual install (without the env-var flow)

Copy `manifest.json`, `main.js`, and `styles.css` into `<vault>/.obsidian/plugins/instagram-dm-inbox/`, then enable in *Settings → Community Plugins* (after disabling Restricted Mode).

## Tests

```bash
npm test
```

Vitest suite covers pure helpers (`resolveConversation`, `rewriteCanvasPaths`, filename sanitization) against a hand-rolled `obsidian` module stub in `test/obsidian-stub.ts`.

## Release

The GitHub Actions workflow at `.github/workflows/release.yml` triggers on any tag matching `v*.*.*`, builds the plugin, and attaches `main.js` + `manifest.json` + `styles.css` to the GitHub release.

To cut a new release:

```bash
# bump version in manifest.json + versions.json (map new-plugin-version → min-obsidian-version)
git commit -am "chore: bump to vX.Y.Z"
git tag vX.Y.Z
git push origin main --tags
```

## Layout

- `src/main.ts` — plugin entry: poll loop, commands, event listeners.
- `src/api.ts` — HTTP client for the paired IG CRM server.
- `src/vault.ts` — write profile + message notes, move conversation folders, migrate legacy layouts.
- `src/canvas.ts` — JSONCanvas layout: one column per sender, chained messages, path rewrites on status moves.
- `src/settings.ts` — Obsidian settings tab UI including the tag-config editor.
- `src/types.ts` — shared TypeScript interfaces + default settings shape.
- `test/` — Vitest tests + `obsidian-stub.ts`.
