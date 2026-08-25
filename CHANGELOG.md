# Changelog

All notable changes to the Instagram DM Inbox plugin.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## 0.3.1 - 2026-08-25

### Fixed

- A trigger code sometimes moved a conversation and then moved it straight back.
  Obsidian's metadata cache is debounced, so for a second or two after the move it still
  reported the old `funnel:` value. The plugin read that as you editing the note by hand,
  put the conversation back, and told the server the old stage. It now confirms against
  the note on disk before acting on a change, so a stale cache cannot undo a move.
- A `.canvas` file that is not valid JSON is no longer overwritten. It used to load as an
  empty canvas, which was then replaced by a rebuilt roster, taking any card you had
  placed with it. The file is now left alone and the plugin says so once.
- A funnel stage folder you made yourself with a lowercase name, such as `shipped`, no
  longer breaks its index note. The name was being re-capitalised to `Shipped`, which on
  a case-insensitive drive stopped index notes being maintained for every stage after it.

## 0.3.0 - 2026-08-20

### Needs Obsidian 1.13 or newer

Obsidian 1.13 replaced the old way of building a settings tab with a declarative one,
and kept the old way only as a fallback for plugins supporting earlier versions. This
plugin carried both. Requiring 1.13 means there is one settings tab instead of two
descriptions of it that could drift apart — which they have, twice.

If you are on an older Obsidian, nothing breaks: it keeps installing 0.2.1, which has
every fix listed below it. Update Obsidian to carry on getting new versions.

### Fixes

- Stage folders in the file explorer are hidden with a cheaper CSS rule. No visible
  change; the previous one used a selector the community review flags for its cost.
- Internal: two unused imports removed, and `npm run typecheck` now runs in CI so that
  cannot ship again.

## 0.2.1 - 2026-08-20

Nothing here changes your vault or your settings.

### Stage folders are no longer coloured in the file explorer

Those colours were applied through a stylesheet the plugin built while running,
which the community review flags as an error: styling belongs in `styles.css`,
which Obsidian loads for you. The colours needed your own folder names inside the
selector, which a static file cannot express, so the feature is gone rather than
rebuilt on something more fragile.

The canvas and the graph still colour by stage, and both keep working the way they
did. `_meta` is still hidden.

### A new stage no longer starts with `!` in its trigger code

The field was pre-filled with a single `!`, and because a `!` code matches the
*end* of a reply, leaving it alone meant every reply you finished with an
exclamation mark refiled that conversation. The field now starts empty, so saving
asks you for a code instead of assuming a broad one.

A bare `!` still works if you want it. Ties go to the longest code, so it collects
whatever a more specific code did not claim, and the row now says as much.

### Fixes

Six of these came out of a review of the move and settings paths. All of them
predate this release.

- **Dragging a conversation folder in from outside the inbox tree could dismantle
  a different one.** If a conversation with the same handle was already filed in
  your default stage, its message notes were moved into the folder you had just
  dragged in and the emptied folder was trashed, reported as an ordinary stage
  change. Dragging in from outside now only updates the note it lands on.
- **Stage edits could revert a rename made on another device.** The settings rows
  were built once when the plugin loaded, before the stage list had been fetched,
  so opening settings for the first time in a session showed a stale list and
  "Save stages" pushed it back. The rows now follow the saved list, and an edit
  you have started is never overwritten.
- **Syncing no longer runs during a layout migration.** Both move folders, and
  nothing stopped them running at once.
- **A stage change could bounce back.** For a moment after the folder moved, before
  the server had acknowledged it, a sync could disagree and move it back —
  overwriting a `funnel:` you had just typed by hand.
- **A stage folder you created yourself with a lower-case name now works.** Moving
  a conversation into it reported success and did nothing.
- **Emptying the inbox folder field no longer resets it.** It saved as you typed,
  so clearing the box instantly repointed the plugin at the default folder and
  orphaned your existing tree. It now keeps what is stored until you type
  something else.
- **A stage name starting with `!`, `@`, `%`, `{` or `-` no longer breaks the
  contact note it is written into.** The stage went into the note's frontmatter
  unquoted, and those characters mean something to YAML, so the block stopped being
  readable: no display name, stage changes reporting failure while still moving the
  folder, and statuses refusing. `!hot` was easy to land on, given the trigger-code
  box beside the name says `!code`.
- The message about two stages sharing a blank trigger code names which ones.
- Internal: frontmatter reads are typed. Stage names now reject DEL and the C1
  control block as well as C0, matching the server; one in a stage name produced
  frontmatter Obsidian could not parse.

## 0.2.0 - 2026-08-03

Two things need reading before you upgrade: the word "status" now means
something different, and your vault gets reorganised.

### You will be asked to migrate

On first launch the plugin explains the layout change and waits for you to
confirm before touching a file. Nothing is deleted, only renamed, every move is
written to `_meta/migration-v020.log`, and your old canvas is copied aside.
Syncing pauses until you approve. If the check itself fails, syncing stays
paused and you get a notice; run "Migrate inbox layout" from the command
palette to retry.

That command stays in the palette afterwards. If old notes turn up later, from
a backup you restored or a device that is still on 0.1.6, run it again and they
will be converted too. On a folder that is already up to date it tells you so
and changes nothing.

If you still had conversations in the older `Profiles/` and `Messages/`
folders, those are converted in the same pass. That step used to run on
startup without asking.

### "Status" was renamed to "funnel stage"

The thing that decides which folder a conversation lives in, and its colour in
the file explorer, the canvas and the graph, is now called a **funnel stage**.
Nothing about how it works has changed. The `status:` field in each profile
note becomes `funnel:`, converted for you the first time the plugin sees the
note.

If you had scripts, Dataview queries or Bases views keyed on `status:`, point
them at `funnel:`.

### Added
- **A status for each conversation**, separate from its stage: free text like
  "waiting on money" or "thinking", set from the right-click menu or the
  command palette. It lives in the note's frontmatter and changes nothing about
  folders, colours or the graph. Entirely optional; if you never set one, the
  field never appears. Anything you type is remembered against that stage and
  offered next time.
- Conversations can be moved by dragging their folder into another stage
  folder, not only from the menu.
- "Migrate inbox layout" and "Set conversation status" commands.
- Debug logging setting, off by default.
- The settings tab now appears in Obsidian's settings search on 1.13 and newer.
- "Set up graph view" is in plugin settings too, not only the command palette.
- Your previous graph settings are backed up to
  `_meta/graph.json.pre-igcrm.bak` before "Set up graph view" writes.

### Changed
- The folder is called your **inbox folder** now, not your "CRM folder", and a
  brand-new install creates `Instagram DMs` rather than `CRM`. Upgrading
  changes nothing: your existing folder and its name are kept exactly as they
  are. You can rename it in settings whenever you like.
- New vault layout. Message notes now live in a `_history/` subfolder inside
  each conversation, so the file tree shows contacts instead of a wall of
  messages. Profile notes get a "Recent messages" section that the plugin
  keeps up to date.
- The canvas is now a contact roster: one card per contact rather than one
  node per message. Cards you move or resize stay where you put them, and
  text cards you add are left alone. Card colour shows the stage and matches
  the file explorer and the graph, so a card you recolour by hand gets painted
  back on the next sync.
- The canvas moved to `_meta/Inbox.canvas`. If you had set a custom canvas
  path, yours is kept.
- Message notes carry a single readable `date` property. The old `platform`,
  `mid`, `timestamp` and `preview` properties are gone.
- Trigger codes no longer need a `!` prefix. A plain phrase like
  `Great! See you then` moves the conversation when your whole reply matches
  it. Codes starting with `!` still match the end of a reply, and codes can
  be up to 120 characters.
- Stage folders are coloured in the file explorer, each with its own colour
  and a matching line down its conversations. The plugin's `_meta` folder is
  hidden from the tree.
- An index note in each stage folder, `@New.md` inside `New/` and so on,
  listing that stage's contacts. This is what gives the graph view something
  to group contacts around. Each one has a `## Notes` heading you can write in.
- "Set up graph view" now refuses while a graph view is open, because an open
  graph writes its own settings back on close and would discard the change.
- The settings tab says less. The explanations of trigger codes, stage naming
  rules and how statuses are remembered live on the plugin page rather than
  crowding the controls.
- The console is much quieter. A failure that repeats every poll is now logged
  once rather than once every few seconds.

### Fixed
- Each line in a profile's Recent messages showed the date twice, once as the
  timestamp and again inside the link. It now reads
  `2026-08-11 17:32 [[... - hey|hey]]`. Existing profiles correct themselves the
  next time a message arrives.
- A DM that could not be filed after repeated attempts was acknowledged to the
  server and lost. Its text is now saved into an `_unfiled` folder inside your
  inbox folder first, and if even that fails the message is left on the server
  rather than dropped. Move the note wherever you like; nothing manages it.
- Two Instagram handles that differ only by leading or trailing underscores,
  like `alice` and `_alice_`, shared one conversation folder and had their
  messages merged. Existing folders are found and kept where they are.
- An inbox folder nested inside another folder, like `Work/CRM`, silently
  disabled every command, both right-click items and drag-to-move. A stray
  trailing slash in the setting did the same.
- The canvas removed cards you had added yourself, and the migration swept
  your own notes out of a conversation folder into `_history/`. Both now leave
  anything the plugin did not write alone.
- Settings changed on another device through Obsidian Sync were overwritten by
  the next poll.
- Every button in the settings tab did nothing on Obsidian older than 1.13.
- Messages arriving during a stage change could be written into a second copy
  of a contact's folder, which never healed itself.
- A sync whose acknowledgement failed would write every message again on the
  next attempt, leaving duplicate notes, while still reporting success.
- A new contact did not appear in its stage's index note, and so stayed
  invisible in the graph, until the next poll that happened to find no
  messages.
- A stage's index note kept linking the last contact to leave it.
- Editing a profile note while the plugin was writing to it could lose what you
  typed.
- Dragging a conversation into another stage folder could be silently undone.
- A stage change the server permanently rejected was retried forever, and quietly
  excluded that conversation from syncing.
- Moving a conversation to another stage now moves the whole folder in one go.
  Previously the `_history` subfolder could be left behind.
- Stage names are checked before saving. A name like `follow/up` used to
  create a folder the plugin couldn't find again, which made stage changes do
  nothing at all.
- A conversation whose note had a `status:` line in its body, rather than its
  frontmatter, could have that line rewritten instead of the real field.
- Your stage list is now read back from the server on startup, so reinstalling
  no longer resets it to the three defaults.

## 0.1.6 - 2026-07-31

### Fixed
- The settings tab was empty on Obsidian 1.13 and newer: no conversation
  statuses, no Test connection button, and the API key shown as plain text
  instead of masked. Obsidian skips the plugin's own settings rendering when a
  plugin also supplies declarative definitions, and 0.1.4 had added those
  without moving everything across.

## 0.1.5 - 2026-07-19

### Changed
- Documentation refresh.

## 0.1.4 - 2026-07-19

### Added
- Settings-search integration via the declarative settings API.

## 0.1.3 - 2026-07-19

### Changed
- Raised the minimum Obsidian version to 1.6.6, needed for moving files to
  the trash instead of deleting them outright.

## 0.1.2 - 2026-07-19

### Fixed
- Community review feedback: heading conventions and DOM helper usage in the
  settings tab.

## 0.1.1 - 2026-07-19

### Fixed
- Community review feedback: safer file deletion (system trash), styling via
  CSS classes, stricter typings.

## 0.1.0 - 2026-07-19

### Added
- First release. Incoming Instagram Business DMs sync into vault notes, each
  sender gets a profile note, threads are drawn on a canvas, and status
  folders can be driven by trigger codes in your replies or changed by hand
  from the command palette, the right-click menu, or the note's frontmatter.
