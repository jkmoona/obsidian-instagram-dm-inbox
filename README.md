# Instagram DM Inbox

Mirrors Instagram direct messages into an Obsidian vault. Each message is written as a note
and filed under a profile note for its sender.

Conversations are organised into user-defined funnel stages. A stage is the folder the
conversation occupies. The file explorer, the canvas and the graph view all read from it.

## Requirements

- Obsidian 1.13 or newer. Earlier versions resolve to plugin 0.2.1, which functions but
  receives no further updates.
- An Instagram professional account, Business or Creator.
- A companion server.

## Server

Instagram delivers messages by webhook to a public HTTPS endpoint. A desktop application
cannot expose one. The plugin therefore pairs with a server. That server holds the access
token, receives the webhooks, and queues messages for collection.

A hosted instance runs at
[crm4obsidian-production.up.railway.app](https://crm4obsidian-production.up.railway.app),
free to use at present.

## Installation

1. **Settings → Community plugins → Browse**, search "Instagram DM Inbox", install, enable.
2. Open the hosted instance and select **Connect Instagram**.
3. Copy the server URL and API key issued on the page that follows.
4. Enter both under **Settings → Instagram DM Inbox**.
5. Run the first sync from the ribbon icon or the **Sync now** command.

Subsequent messages sync automatically.

## Features

- One note per message. One profile note per sender, holding editable notes and tags.
- Stage changes from Obsidian: context menu, folder drag, or the `funnel` frontmatter field.
- Stage changes from Instagram: a trigger code at the end of a reply, for example `!done`.
- Optional free-text status within a stage, such as `waiting on quote`.
- Graph view coloured by stage, applied by the **Set up graph view** command.
- Canvas board with one card per contact, arranged by hand.

## Configuration

Server URL, API key, inbox folder, canvas filename, poll interval, debug logging, and the
funnel stage list.

Three stages ship by default: `new`, `pending` and `done`. They can be renamed, removed or
replaced, to a maximum of 20. Exactly one stage must have an empty trigger code; new
conversations are filed there.

## Privacy

Message text is queued on the server only until the vault acknowledges it, typically within
seconds. The server then deletes it.

The server also reads the account's own most recent reply in each conversation, about twice
a minute. This detects a trigger code. Instagram emits no webhook for messages the account
owner sends. That text is matched against the configured codes and is not retained.

No third-party sharing, no advertising, no analytics on message content. Access tokens are
encrypted at rest.

[Privacy policy](https://crm4obsidian-production.up.railway.app/privacy.html) ·
[Terms of service](https://crm4obsidian-production.up.railway.app/terms.html)

## License

MIT. See [LICENSE](LICENSE).

## Development

See [DEVELOPMENT.md](DEVELOPMENT.md).
