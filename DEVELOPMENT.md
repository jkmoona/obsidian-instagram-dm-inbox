# Development

## Build

```bash
npm install
npm run build
```

Produces `main.js`. The build prints the path it wrote. A deployable plugin folder is
`manifest.json`, `main.js` and `styles.css`.

## Auto-install into a vault

Copy `.env.example` to `.env.local` and set `OBSIDIAN_VAULT_PATH`. `npm run dev` watches;
`npm run build` runs once. Both write the three files into
`<vault>/.obsidian/plugins/instagram-dm-inbox/`. Reload with
`Cmd/Ctrl+P → Reload app without saving`. Delete `.env.local` for CI and release builds.

The build rejects a path containing no `.obsidian` folder, and prints the file it wrote.
An earlier version created the folder tree at any path and reported success. A stale path
then installed nothing, silently.

Only those three files are written. `data.json` holds the server URL and API key. It
survives a rebuild, so no reconnect is needed after an edit.

## Manual install

Copy `manifest.json`, `main.js` and `styles.css` into
`<vault>/.obsidian/plugins/instagram-dm-inbox/`. Enable under
*Settings → Community Plugins*, with Restricted Mode off.

## Tests

```bash
npm test          # vitest
npm run typecheck # tsc over src/, with noUnusedLocals
```

Both run in the release workflow and in the monorepo's mirror pre-flight. Either one
failing blocks a release. `typecheck` was added after a release shipped two unused imports
that only the community review caught.

The suite runs against a hand-rolled `obsidian` stub in `test/obsidian-stub.ts`. The stub is
strict where strictness matters: `createFolder` throws when the folder exists, `TFile`
identity survives a rename, and the frontmatter serialiser quotes as Obsidian does.

`npm run typecheck` covers `src/` only. The tests replace the `obsidian` module with the
stub, which `src/` does not typecheck against, so one `tsc` invocation cannot cover both.

## Community review rules

The automated review on a submitted release checks what `npm test` and `tsc` do not. Every
rule below has been broken by this plugin at least once. Each is enforced by a test rather
than trusted to memory. The enforced ones live in `test/styles.test.ts`, which greps
`src/` deliberately. It runs locally, in the mirror pre-flight, and in the release workflow.

| Rule | Enforced by |
| --- | --- |
| No stylesheet built at runtime. No `createElement("style")`, no `document.head`, no `insertRule`. | `builds no stylesheet at runtime` |
| No imperative styling. No `setCssStyles`, no `el.style.x =`, no inline `style:`. | `assigns no styles imperatively` |
| Every `igcrm-` class the source names exists in `styles.css`. | `defines every igcrm- class the source references` |
| No `!important`, so a user snippet can still win. | `never uses !important` |
| No `:has()` in `styles.css`; the review flags its invalidation cost. | `uses no :has() in styles.css` |
| No unused imports or locals in `src/`. | `noUnusedLocals`, run by `npm run typecheck` |
| `vault.adapter` only where the Vault API cannot reach, which is `graph.json`. | `reaches for the adapter only where the Vault API cannot` |
| Settings render declaratively only; no `display()`, no `renderItem`. | `renders only declaratively` |

Two rules have no test, because they constrain how code is written rather than what ships.

- **Anything dynamic belongs in `styles.css`, keyed on a class or attribute the plugin
  sets.** 0.2.0 generated a stylesheet to colour stage folders, because the selector needed
  a user-defined folder name. The review rejected it as an error and the feature was
  dropped. Rebuilding it requires a data attribute on the explorer DOM and static
  declarations.
- **Every `eslint-disable` needs an inline description after `--`.** A reason on the line
  above does not count.

### Clipboard access is not a defect

The clipboard line sits under `## Behavior`, beside `Vault Read: Pass` and
`Vault Write: Pass`. That section is a capability inventory, so it needs no response. The
single call is `copyDebugInfo`, which is user-initiated and reports the server URL and API
key as `set` or `empty` rather than by value.

### Settings render one way only

`minAppVersion` is 1.13.0 as of 0.3.0, so `getSettingDefinitions()` is the whole settings
tab. There is no `display()` and no second renderer.

This closes the `display()` deprecation the review raised three times. The override itself
is sanctioned by Obsidian's typings, which describe it as a fallback for versions older than
1.13.0. The finding was about `refresh()` calling it. Requiring 1.13 removed both. Older
Obsidian installs receive 0.2.1 through `versions.json`.

Do not reintroduce an imperative path. It caused two shipped bugs. 0.1.4 lost the stage
editor when the declarative definitions drifted from it. 0.1.6 lost settings-search
indexing when the declarative side was deleted instead.

### Deferred: ESLint

The reviewer runs `eslint-plugin-obsidianmd` and type-checked `typescript-eslint`. This
repo runs neither, which is how a release shipped eleven `no-unsafe-*` findings and two
undescribed directives. Adding it is deferred until no review cycle is in progress.
The fallout cannot be sized without installing it.

## Held in the monorepo

This directory is a mirror of the monorepo's `plugin/`. Three things live there and are not
available here: the manual test checklist for real Obsidian and drag and drop, the load
test, and the throwaway vault.

## Release

`.github/workflows/release.yml` triggers on a tag matching `*.*.*` but not `v*`. It then
checks the tag against `manifest.json` and `versions.json`, and checks the tag sits on the
default branch. It runs the tests, builds, and attaches `main.js`, `manifest.json` and
`styles.css` to the GitHub release.

**Tag naming matters.** Obsidian's community directory requires the release tag to equal
`manifest.json`'s `version` exactly, with no `v` prefix. Use `0.2.0`, not `v0.2.0`.

The version bump belongs in the monorepo, because a mirror run replaces every tracked file
here. The two-repo procedure is in the monorepo's root README.

## Layout

- `src/main.ts`: plugin entry, poll loop, commands, event listeners.
- `src/api.ts`: HTTP client for the paired server.
- `src/vault.ts`: profile and message notes, conversation moves, legacy layout migration.
- `src/canvas.ts`: JSONCanvas roster, one card per contact, coloured by stage, with path
  rewrites when a conversation moves.
- `src/palette.ts`: the shared colour list, indexed by a stage's position.
- `src/graph_colors.ts`: graph-view colour groups and filter terms.
- `src/log.ts`: console helpers that keep the poll loop from flooding it.
- `src/settings.ts`: the settings tab, declarative only.
- `src/types.ts`: shared interfaces and the default settings shape.
- `test/`: Vitest tests plus `obsidian-stub.ts`, the in-memory Obsidian shim.
