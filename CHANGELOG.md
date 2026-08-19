# Changelog

All notable changes to the Instagram DM Inbox plugin.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

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
