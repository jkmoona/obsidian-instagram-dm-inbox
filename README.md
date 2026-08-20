# Instagram DM Inbox

Mirrors your Instagram Business DMs into your Obsidian vault, one note per message, filed under a profile note for the person who sent it. You sort conversations into funnel stages you define, and the stage is just the folder the conversation sits in, so the file explorer, the canvas and the graph all agree without any extra bookkeeping.

Needs Obsidian 1.13 or newer. On an older version Obsidian installs 0.2.1 instead, which works but stops receiving updates.

## What it looks like

Each conversation lives in a folder named after its funnel stage:

```
Instagram DMs/
  _meta/
    Inbox.canvas
  New/
    @alice/
      @alice.md                  <- name, username, stage, status, tags, your notes
      _history/
        2026-07-18 - hey there.md
  Pending/
    @bob/
      @bob.md
      _history/
        2026-07-17 - hi.md
  Done/
    @charlie/
      @charlie.md
      _history/
        2026-07-15 - see you then.md
```

The profile note is the one you'll actually work in. It holds their Instagram profile name in a `name` field where they've set one, the sender's username, their current funnel stage, an optional status, a `tags: []` field you can fill with anything useful (industry, priority, how they found you), a list of their recent messages, and a `## Notes` heading for whatever you want to write. The plugin only rewrites the `funnel` field, the `status` field, the `name` field and the recent-messages list, so your own notes are safe.

Folders stay named after the username, because names aren't unique and people change them. The heading reads `# Alice Smith` once the name is known, and `# @alice` until then. If you rewrite that line yourself the plugin leaves it alone from then on.

You'll see a pair of HTML comments around the Recent messages list:

```text
<!-- igcrm:recent-start -->
## Recent messages

- 2026-07-18 14:03 [[Instagram DMs/New/@alice/_history/2026-07-18 - hey there|hey there]]
<!-- igcrm:recent-end -->
```

They mark the only part of the body the plugin rewrites, and they're there so you can see where that is. Everything outside them is yours and is never touched. Anything you type *between* them will be replaced the next time a message arrives, so put your own writing under `## Notes` instead. Obsidian hides them in reading view; you'll only see them in source mode. The stage index notes use the same pair, named `igcrm:contacts-*`, around their contact list.

Individual DMs go into `_history/` with a readable date and a link back to the profile. They stay out of the way but remain searchable.

`_meta/Inbox.canvas` holds one card per contact. It's a board you can rearrange however you like: move cards, resize them, add your own text notes and arrows. The plugin adds new contacts and removes departed ones without moving anything you've placed. Card colour is the one exception: it shows the contact's funnel stage, so it's kept in step with the folder and a card you recolour by hand gets painted back.

Each stage folder also holds an index note, `@New.md` inside `New/` and so on, listing that stage's contacts. It's what lets the graph view group them, and there's a `## Notes` heading in it if you want somewhere to keep thoughts about the stage as a whole.

## Funnel stages, and statuses

There are two separate things here, and you can use either one on its own.

The **funnel stage** is the folder a conversation sits in. It drives everything structural: the folder, the card colour on the canvas, the cluster in the graph, and the index note. Stages work like Kanban columns.

You get `new`, `pending` and `done` to start with, and nothing depends on those three: rename them, delete them, or replace all of them with your own. Up to 20. The only rules are that you keep at least one, that exactly one of them has a blank trigger code (that's where new conversations land), and that names are unique and usable as a folder name.

Removing a stage leaves its conversations alone. The folder and the notes in it stay exactly where they are, and the plugin stops treating that folder as a stage. To bring those conversations back into your funnel, drag them into a stage you still have.

The **status** is an optional free-text detail *within* a stage, like `waiting on money` or `thinking`. It lives in the note's frontmatter and changes nothing about folders, colours or the graph. It is entirely opt-in: if you never set one, no status field ever appears in your notes.

If you only want simple filing, use stages and ignore statuses. If you'd rather have one bucket and tag everything by hand, configure a single stage and use statuses instead. Neither depends on the other.

## Moving a conversation

New DMs show up within seconds of arriving.

You can move a conversation between stages by finishing an Instagram reply with a trigger code, from your phone, the web, or Business Suite. A code beginning with `!` fires when it ends your reply, so `Great, see you then! !done` files that conversation under Done. A code without `!` has to match your whole reply exactly, which lets you use a real sentence like `Great! See you then` as the trigger.

Give a `!` code something after the `!`. It matches the end of your reply, so a code of just `!` catches `Thanks!` and `see you tomorrow!` along with everything else you end that way, which is probably not what you meant. If it *is* what you meant, it works, and it's worth knowing why: when two codes both match, the longer one wins. So a bare `!` sits underneath your real codes as a catch-all, taking anything you end with an exclamation mark that a more specific code didn't already claim.

From inside Obsidian there are three ways: right-click the profile or its folder and pick *Move to funnel stage*, drag the conversation's folder into another stage folder, or edit the `funnel:` field in the note. All three move the folder and tell the server. All three also need a stage that already exists: typing a new name into `funnel:` won't create one, it just tells you the stage is unknown. Stages are made in plugin settings.

To set a status, right-click and pick *Set conversation status*, or run it from the command palette. The picker offers whatever statuses that stage already knows about, accepts anything else you type, and has a *Clear status* row. Anything new you type is remembered against that stage, so it's offered next time.

`_meta`, which holds the canvas and the plugin's own logs, is hidden from the file explorer so it doesn't clutter your tree.

If a message ever can't be filed into a conversation, its text is written to `_unfiled` instead of being dropped, and you get a notice. That folder stays visible on purpose, and nothing in it is managed: read the note, move it, delete it, whatever you like.

### When the server is unreachable

Moving a conversation still works. The folder moves straight away, you get a notice saying the server hasn't caught up, and the change is retried on the next sync that gets through. All three ways of moving behave the same, because they share one code path.

That queued change is held separately from what the plugin thinks the server knows, which is deliberate: if it recorded the move as already synced, the server would look out of date and the next sync would drag the folder back. Instead that one conversation is left alone until the retry lands.

Statuses work offline completely, because a status only ever lives in your note. So does inventing a new status name: it's saved locally first, and a failed sync costs you the suggestion for next time, never the status itself.

What doesn't work is anything that has to come from the server: new DMs, and *Test connection*. There's no indicator for this, so the first sign is usually one of those going quiet.

## Your contacts in the graph view

Since the stage is just the folder a conversation sits in, the graph view can colour contacts by stage, and a conversation recolours itself when it moves.

Run *Set up graph view*, from plugin settings or the command palette. Two things happen. Each stage gets its own colour, so your contacts show up as coloured clusters. And the graph filter gains `-path:"/_history/" -path:"/_meta/"`, which hides the individual message notes and the canvas file, since those outnumber your contacts and bury them.

Close the graph view first: an open graph writes its own settings back when it closes and would overwrite the change. The command refuses and tells you if it finds one open.

Reordering your stages recolours the canvas straight away, but not the graph, because the graph keeps its own copy of the colours. Run *Set up graph view* again afterwards if you want both to match.

The command only adds. Colour groups you made yourself stay as they are, anything already in the filter box is kept, and running it a second time does nothing. Your previous graph settings are backed up to `_meta/graph.json.pre-igcrm.bak` inside your inbox folder the first time it runs. To get the full graph back, clear the filter box in the graph settings.

### Connecting two contacts

Out of the box the graph gives you one cluster per stage, each gathered around that stage's index note. There is no line between stages, because nothing links across one.

You can add those yourself, and it is worth knowing you can. Write a link to another contact anywhere in a profile's `## Notes`, like `[[@bob]]` in alice's note, and the graph draws an edge between them however far apart their stages are. Useful for a referral, two people at the same company, or a couple booking together.

Links are what the graph draws edges from; the stage only decides the colour. So a connection you make survives everything the plugin does afterwards: your `## Notes` is yours, the plugin only ever rewrites the frontmatter and its own Recent messages block, and when a conversation changes stage the link follows it.

To do it by hand instead, open Graph view → the settings gear. Under *Groups*, add a group per stage with the query `path:"Instagram DMs/New"`, `path:"Instagram DMs/Pending"`, `path:"Instagram DMs/Done"`, using your own folder name if you changed it. Under *Filters*, put `-path:"/_history/" -path:"/_meta/"` in the search box.

## Requires an account

This plugin does not work on its own. It talks to a companion server that holds your Instagram connection and receives Meta's webhooks, because Instagram will not deliver messages directly to a desktop app.

Connect at [the hosted service](https://crm4obsidian-production.up.railway.app), which is run by the plugin author and free to use. If you'd rather host it yourself, ask and you'll get the backend code.

## How to install

1. In Obsidian: *Settings → Community plugins → Browse*, search for "Instagram DM Inbox", then install and enable it.
2. Go to [the hosted service](https://crm4obsidian-production.up.railway.app), click *Connect Instagram* and finish the Instagram login.
3. Copy the server URL and API key from the page it shows you.
4. Paste both into *Settings → Instagram DM Inbox*.
5. Click the sync icon in the ribbon, or run *Sync now* from the command palette, to fill the vault. After that new DMs arrive on their own.

## Privacy

Incoming DM text sits on the server only until your vault picks it up, usually a few seconds. Once Obsidian confirms it has the message, the server deletes it.

The server also reads the most recent message in each of your conversations, about twice a minute. Instagram sends no webhook for messages you send yourself, so this is the only way a trigger code typed at the end of your own reply can move a conversation. That text is matched against your trigger codes and is not stored.

A contact record for each person who messages you, holding their username and current stage, is kept so your filing survives a restart.

Instagram access tokens are encrypted where they're stored, with a key only the server operator holds.

Nothing goes to third parties. No ads, and no analytics on your messages.

The full policy is [here](https://crm4obsidian-production.up.railway.app/privacy.html).

## Configuration

The settings tab has:

- Server URL, copied from the connect page.
- API key, also from the connect page.
- Inbox folder, where everything lives. New installs get `Instagram DMs`; rename it to whatever you like, ideally before the first sync so there is nothing to move. Upgrading from 0.1.x keeps `CRM`.
- Canvas filename, relative to the inbox folder. Defaults to `_meta/Inbox.canvas`.
- Poll interval in seconds. Defaults to 5.
- Debug logging, off by default.
- Funnel stages, where you edit the list of names, trigger codes and suggested statuses.

A few rules for stages. Exactly one has to leave its trigger code empty, and that's where new conversations land. Trigger codes can be up to 120 characters. Stage names turn into folder names, so they can't contain `\ / : * ? " < > | # ^ [ ]`, can't begin with `_`, and can't begin or end with a dot. Spaces and non-English letters are fine, so `Waiting on client` and `Beklemede` both work.

Reordering stages changes their colours, since the colour comes from a stage's position in the list.

Statuses have no such rules; they never become folder names. Up to 30 per stage, 64 characters each.

## Requirements

An Instagram Business or Creator account linked to a Facebook page, and a running server (the hosted one above by default).

## License

MIT. See [LICENSE](LICENSE).

## Development

See [DEVELOPMENT.md](DEVELOPMENT.md).
