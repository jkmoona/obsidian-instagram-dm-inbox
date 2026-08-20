# Development

## Build

```bash
npm install
npm run build
```

Produces `main.js`, unless `.env.local` sends it into a vault (below). Either way the build prints where it wrote. The deployable plugin folder is `manifest.json` + `main.js` + `styles.css`.

## Auto-install into your vault

`cp .env.example .env.local` and set `OBSIDIAN_VAULT_PATH` to your vault. Then `npm run dev` (watch) or `npm run build` (one-shot) writes `main.js` + `manifest.json` + `styles.css` directly into `<vault>/.obsidian/plugins/instagram-dm-inbox/`. Reload Obsidian (`Cmd/Ctrl+P → Reload app without saving`) to see changes. Delete `.env.local` for CI / release builds.

The build refuses a path with no `.obsidian` folder in it, and prints the file it wrote every time. Both exist because a stale path here is invisible: it used to create the folder tree wherever you pointed it and report success, so you could spend an hour testing a fix that was never installed.

Only those three files are touched. Your plugin settings (`data.json`, which holds the server URL and API key) survive across rebuilds, so you don't have to re-connect Instagram after each edit.

## Manual install (without the env-var flow)

Copy `manifest.json`, `main.js`, and `styles.css` into `<vault>/.obsidian/plugins/instagram-dm-inbox/`, then enable in *Settings → Community Plugins* (after disabling Restricted Mode).

## Tests

```bash
npm test          # vitest
npm run typecheck # tsc over src/
```

The suite runs against a hand-rolled `obsidian` module stub in `test/obsidian-stub.ts`, which is deliberately as strict as the real thing where that matters: `createFolder` throws when the folder exists, `TFile` identity survives a rename, and the frontmatter serialiser quotes the way Obsidian's does. Making the stub permissive is how bugs hide.

`npm run typecheck` covers `src/` only. The tests swap the `obsidian` module for that stub, which the plugin source does not typecheck against, so pointing `tsc` at both at once cannot work. Vitest is what exercises the tests.

## Community review rules

The automated review that runs on a submitted release checks things `npm test` and
`tsc` do not. Everything below is a rule this plugin has actually broken, so each
one is enforced by a test rather than trusted to memory. The enforced ones live in
`test/styles.test.ts`, which greps `src/` on purpose; `npm test` runs it locally, in
the mirror pre-flight, and in the release workflow, so a violation cannot reach a
release.

| Rule | Enforced by |
| --- | --- |
| No stylesheet built at runtime. No `createElement("style")`, no `document.head`, no `insertRule`. | `builds no stylesheet at runtime` |
| No imperative styling. No `setCssStyles`, no `el.style.x =`, no inline `style:`. | `assigns no styles imperatively` |
| Every `igcrm-` class the source names exists in `styles.css`. | `defines every igcrm- class the source references` |
| No `!important`, so a user snippet can still win. | `never uses !important` |
| `vault.adapter` only where the Vault API cannot reach, which is `graph.json`. | `reaches for the adapter only where the Vault API cannot` |
| Both settings render paths stay, declarative and imperative. | `keeps both the declarative and the imperative rendering paths` |

Two more that no test covers, because they are about how you write rather than what
ships:

- **Anything dynamic goes in `styles.css`, keyed on a class or attribute the plugin
  sets.** 0.2.0 generated a stylesheet to colour stage folders, because the selector
  needed a user-defined folder name, and the review rejected it as an error. The
  feature was dropped rather than rebuilt. If it ever comes back it needs a data
  attribute stamped onto the explorer DOM, with the declarations static.
- **Give every `eslint-disable` an inline description**, after a `--`. The reason
  sitting on the line above does not count.

### Two report lines that are not defects

- **Clipboard access, under `## Behavior`.** Read where it sits: next to
  `Vault Read: Pass` and `Vault Write: Pass`. That section is a capability
  inventory, not a defect list, so there is nothing to answer and answering it
  reads as defensive. For your own reference: the one call is `copyDebugInfo`,
  user-initiated and write-only, and the payload reports the server URL and API key
  as `set`/`empty` rather than by value.
- **`display()` is deprecated since 1.13.** Keep it, for one reason only:
  `minAppVersion` is 1.6.6, so on anything below 1.13 `getSettingDefinitions()` is
  never called and `display()` is the whole settings tab. Do not justify it with the
  test that asserts both paths exist — that test is a consequence of the choice, not
  evidence for it.

  Open question, deliberately not answered yet: whether to require 1.13 and delete
  the imperative renderer. It would remove a second rendering path that has already
  caused two shipped bugs. It would also strand anyone below 1.13 on the version
  they have. Worth deciding on purpose, not by reflex, and not during a review cycle.

### Worth adding

The reviewer runs `eslint-plugin-obsidianmd` plus type-checked `typescript-eslint`.
This repo has no ESLint, which is why a release shipped eleven `no-unsafe-*`
findings and two undescribed directives. Adding it would catch the next batch before
a reviewer does. Left out so far only because the fallout cannot be sized without
installing it, and it should not land in the middle of a review cycle.

## The manual test pass

The parts a test suite cannot reach, real Obsidian and real drag and drop, are
written up as a checklist in the monorepo this directory is mirrored from.

## The load test and the throwaway vault

Both live in the monorepo this directory is mirrored from, alongside the server they need, so the commands are not available here. See that repository's README if you have access to it.

## Release

The workflow at `.github/workflows/release.yml` triggers on any tag matching `*.*.*` but not `v*`. It checks the tag against `manifest.json` and `versions.json`, checks the tag sits on the default branch, runs the tests, builds the plugin, and attaches `main.js` + `manifest.json` + `styles.css` to the GitHub release.

**Tag naming matters:** Obsidian's community directory requires the release tag to exactly match `manifest.json`'s `version`, with no `v` prefix. Use `0.2.0`, not `v0.2.0`.

Development happens in a monorepo alongside the server, and this repository is a mirror of its `plugin/` directory. The version bump belongs in the monorepo, since a mirror run replaces every tracked file here. The full two-repo procedure is in the monorepo's root README.

## Layout

- `src/main.ts`: plugin entry, poll loop, commands, event listeners.
- `src/api.ts`: HTTP client for the paired server.
- `src/vault.ts`: write profile and message notes, move conversation folders, migrate legacy layouts.
- `src/canvas.ts`: JSONCanvas roster, one card per contact, coloured by funnel stage, with path rewrites when a conversation moves.
- `src/palette.ts`: the shared colour list, indexed by a stage's position.
- `src/explorer_css.ts`: the generated file-explorer stylesheet.
- `src/graph_colors.ts`: graph-view colour groups and filter terms.
- `src/log.ts`: console helpers that keep the poll loop from flooding it.
- `src/settings.ts`: the settings tab, defined declaratively and rendered two ways.
- `src/types.ts`: shared interfaces and the default settings shape.
- `test/`: Vitest tests plus `obsidian-stub.ts`, the in-memory Obsidian shim.
