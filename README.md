# Instagram DM Inbox

Mirror your Instagram Business DMs into your Obsidian vault. Every incoming message lands as a note, senders get profile notes, and the whole thread is drawn as a Canvas graph — so you can triage leads and conversations without leaving Obsidian.

## What it looks like

Each conversation lives in a status folder inside your CRM directory:

```
CRM/
  New/
    @alice/
      @alice.md                     ← profile: username, status, tags, notes
      2026-07-18 - hey there.md     ← one note per DM
  Pending/
    @bob/
      @bob.md
      2026-07-17 - hi.md
  Done/
    @charlie/
      @charlie.md
      2026-07-15 - see you then.md
```

- **Profile notes** carry the sender's IG username, a status field, editable `tags: []`, and a `## Notes` block for free-form annotations.
- **Message notes** carry the timestamp, message id, and a wikilink back to the sender's profile so Obsidian's graph view clusters everything.
- **A master `Inbox.canvas`** at the top of the CRM folder pins one vertical column per sender with messages chained beneath — color-coded so each thread pops.

## Features

- **Automatic inbound sync** — new DMs appear in your vault within seconds.
- **Status folders as a Kanban** — user-configurable statuses (defaults: `new` / `pending` / `done`). Conversations relocate between status folders as their state changes.
- **IG-side trigger codes** — end an Instagram reply with a configured code (e.g. `Great, see you then! !done`) and the conversation flips to that status on its own. Works from any Instagram client — phone, web, Business Suite.
- **Manual overrides** — right-click a profile or its folder in Obsidian → *Set status* → picker. Or edit `status:` in the YAML frontmatter directly; the plugin syncs the folder and the server automatically.
- **Custom tags** — every profile note has a `tags: []` YAML field for occupation, industry, priority, whatever helps your workflow. These are native Obsidian tags and searchable across your vault.

## How to install

1. In Obsidian: *Settings → Community plugins → Browse* → search for **"Instagram DM Inbox"** → *Install* → *Enable*.
2. Head to the hosted service — [https://crm4obsidian-production.up.railway.app](https://crm4obsidian-production.up.railway.app) — and click *Connect Instagram*. Complete the Instagram OAuth flow.
3. Copy the **server URL** and **API key** shown on the confirmation page.
4. In Obsidian: *Settings → Instagram DM Inbox* → paste both values.
5. Click the plugin's ribbon icon (or run *Sync now* from the command palette) to seed the vault. New DMs will flow in automatically from that point on.

## Privacy

- **Inbound DM content is stored temporarily on the hosted server** just long enough for the plugin to fetch it — usually seconds. Once your Obsidian vault acknowledges receipt, the server deletes it.
- **Instagram access tokens are encrypted at rest** on the server (Fernet symmetric encryption with a key held only by the server operator).
- **Nothing is shared with third parties.** No advertising, no analytics on your DM content.
- The hosted service is operated by the plugin author. If you'd rather run the server yourself, the backend code is available on request.

Full policy: [privacy policy](https://crm4obsidian-production.up.railway.app/privacy.html).

## Configuration

Plugin settings tab exposes:

- **Server URL** — your IG CRM server (paste from the connect page).
- **API key** — issued at the connect page.
- **CRM folder** — vault-relative folder for profiles, messages, canvas. Default `CRM`.
- **Canvas filename** — the master canvas file inside the CRM folder. Default `Inbox.canvas`.
- **Poll interval (seconds)** — how often to fetch new messages. Default 5.
- **Conversation statuses** — edit the list of status names + their trigger codes. Codes must start with `!` (e.g. `!done`). Exactly one status must have an empty trigger code — that's the default landing status for new conversations.

## Requirements

- Instagram Business or Creator account, linked to a Facebook page.
- A running IG CRM server (default: the hosted one linked above).

## License

MIT. See [LICENSE](LICENSE).

## Development

See [DEVELOPMENT.md](DEVELOPMENT.md).
