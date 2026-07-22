# Hardened Codex WhatsApp Relay

Repository: <https://github.com/crorella/codex-whatsapp-relay>

This fork is a deliberately reduced version of
[`abuiles/codex-whatsapp-relay`](https://github.com/abuiles/codex-whatsapp-relay),
based on upstream release `v0.4.3` (`974b5e9286faee12bf4bd07ee82bb2f854ea9ab6`).

It keeps only the functionality needed to link a local WhatsApp account, locate
a chat or group, and send a text message from Codex. It uses the unofficial
Baileys WhatsApp Web client, so it is not an official Meta integration.

## Security changes

- URL previews are explicitly disabled on every outbound message, preventing
  the known `link-preview-js` SSRF path.
- The transitive `link-preview-js` peer is forced to patched version `4.0.1`.
- Direct dependency versions and the full transitive graph are locked.
- The WhatsApp-to-Codex controller, background daemon, voice execution, history
  reading, and media-download features are removed.
- Message bodies are not persisted. The local cache contains only the metadata
  needed to resolve chat names and IDs.
- Authentication directories use mode `0700`; credentials and cached metadata
  use mode `0600`.
- Installation uses `npm ci --ignore-scripts`.

## MCP tools

- `whatsapp_start_auth`
- `whatsapp_auth_status`
- `whatsapp_list_chats`
- `whatsapp_send_message`

The relay refuses ambiguous chat-name matches and returns candidates instead of
guessing.

## Installation

Clone a reviewed commit into `~/.codex/plugins/whatsapp-relay`, then run:

```bash
npm ci --ignore-scripts --no-fund --no-audit
```

Add the plugin directory to the personal Codex marketplace with authentication
policy `ON_USE`, restart Codex, and install it from `/plugins`.

After restart, call `whatsapp_start_auth` and scan the QR code from WhatsApp:

`Settings -> Linked Devices -> Link a Device`

## Local state

- Authentication: `plugins/whatsapp-relay/data/auth/`
- Chat metadata: `plugins/whatsapp-relay/data/store.json`

Both locations are excluded from Git. Message bodies are never written to the
metadata cache.

## Verification

```bash
npm run check
npm test
npm audit --package-lock-only --ignore-scripts
```
