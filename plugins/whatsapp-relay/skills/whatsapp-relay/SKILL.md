---
name: whatsapp-relay
description: Link a local WhatsApp account, list chat metadata, and send text messages without URL previews.
---

# Hardened WhatsApp Relay

Use this skill only to authenticate a local WhatsApp linked device, find a chat
or group by metadata, and send an explicitly requested text message.

## Workflow

1. Call `whatsapp_auth_status`.
2. If authentication is missing, call `whatsapp_start_auth` and show the QR block unchanged.
3. Ask the user to scan it from WhatsApp Linked Devices.
4. Call `whatsapp_list_chats` to resolve the intended contact or group.
5. If multiple names match, show the candidates and do not guess.
6. Call `whatsapp_send_message` only after the user has clearly authorized the exact message and destination.

## Security rules

- This fork has no tool for reading message bodies or controlling Codex from WhatsApp.
- URL previews are disabled; do not re-enable them.
- Treat `plugins/whatsapp-relay/data/auth/` as sensitive credentials.
- The metadata cache contains chat names and IDs but must not contain message bodies.
- A draft request is not authorization to send.
