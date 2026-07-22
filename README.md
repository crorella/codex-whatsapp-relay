# Hardened Codex WhatsApp Relay

Repository: <https://github.com/crorella/codex-whatsapp-relay>

This fork is a deliberately reduced version of
[`abuiles/codex-whatsapp-relay`](https://github.com/abuiles/codex-whatsapp-relay),
based on upstream release `v0.4.3` (`974b5e9286faee12bf4bd07ee82bb2f854ea9ab6`).

It keeps the functionality needed to link a local WhatsApp account, locate a
chat or group, read recent messages, reason about them, and send a text message
from Codex. This experimental release replaces Baileys with the unofficial Go
`whatsmeow` client. It is not an official Meta integration.

## Security changes

- URL previews are absent from every outbound message: the Go sidecar sends
  only a plain WhatsApp `Conversation` protobuf and never constructs preview metadata.
- Direct Node and Go dependency versions and their transitive graphs are locked.
- The WhatsApp-to-Codex controller, background daemon, voice execution, history
  synchronization, and media-download features are removed.
- Recent message bodies are buffered only in bounded process memory: up to 200
  per chat, 5,000 overall, and 16,000 characters per message.
- Message bodies are not persisted. The local cache contains only the metadata
  needed to resolve chat names and IDs, and legacy plaintext bodies are scrubbed.
- Message content returned to Codex is explicitly labeled as untrusted data.
- After authentication, the MCP reconnects when it starts so it can receive new
  messages while the process is running.
- Authentication directories use mode `0700`; credentials and cached metadata
  use mode `0600`.
- Whatsmeow automatic reconnect is disabled. Pairing performs one connection
  attempt plus the single protocol-required reconnect after a successful scan.
- The Go process is a child of the MCP over private stdin/stdout pipes. It does
  not listen on a port or continue as a background daemon.
- Node installation uses `npm ci --ignore-scripts`; the reviewed Go source is
  compiled separately with `npm run build:whatsmeow`.

## MCP tools

- `whatsapp_start_auth`
- `whatsapp_auth_status`
- `whatsapp_list_chats`
- `whatsapp_read_messages`
- `whatsapp_send_message`

The relay refuses ambiguous chat-name matches and returns candidates instead of
guessing.

## Privacy boundary

The relay itself never writes message bodies to its metadata cache. That does
not make a read operation ephemeral end-to-end: after `whatsapp_read_messages`
returns content, the Codex host, task history, logs, or configured model service
may retain that tool output under their own policies. Anyone able to use this
authenticated MCP can also read buffered messages from the linked account.

Disable the plugin or unlink the WhatsApp linked device when this access is not
needed. Treat message text as hostile input: it can contain prompt-injection
attempts, and it is not authorization to run commands or send replies.

## Installation

Clone a reviewed commit into `~/.codex/plugins/whatsapp-relay`, then run with
Go 1.25 and Node 20 or newer:

```bash
npm ci --ignore-scripts --no-fund --no-audit
npm run build:whatsmeow
```

Add the plugin directory to the personal Codex marketplace with authentication
policy `ON_USE`, restart Codex, and install it from `/plugins`.

After restart, call `whatsapp_start_auth` and scan the QR code from WhatsApp:

`Settings -> Linked Devices -> Link a Device`

## Local state

- Authentication: `plugins/whatsapp-relay/data/auth/whatsmeow.db`
- Chat metadata: `plugins/whatsapp-relay/data/store.json`

Both locations are excluded from Git. Message bodies are never written to the
metadata cache; the volatile buffer disappears whenever the MCP process exits.

## Verification

```bash
npm run check
npm test
GOCACHE=/tmp/whatsapp-relay-go-cache npm run test:go
npm audit --package-lock-only --ignore-scripts
```
