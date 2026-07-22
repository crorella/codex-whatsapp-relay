# Evaluate a Hardened Whatsmeow Transport

This ExecPlan is a living document. Keep `Progress`, `Surprises & Discoveries`, `Decision Log`, and `Outcomes & Retrospective` current as work proceeds.

## Purpose / Big Picture

The existing hardened Codex WhatsApp relay exposes five MCP tools but cannot complete linked-device registration through Baileys on the user's account. This experiment keeps the same tools and safety boundary while replacing the WhatsApp transport with `whatsmeow`, the Go library already used by the local TataBot project. A successful result is a reviewed build that passes offline tests, can produce one QR code without retry loops, and can report whether WhatsApp accepts or rejects that one pairing attempt. The installed Baileys release remains recoverable until the experiment is proven.

## Progress

- [x] 2026-07-22: Inspected the hardened relay, TataBot bridge, local whatsmeow session layout, and repository instructions.
- [x] 2026-07-22: Created branch `experiment/whatsmeow-transport` and this ExecPlan.
- [x] 2026-07-22: Implemented a Go sidecar using whatsmeow with JSON-lines over private stdin/stdout pipes.
- [x] 2026-07-22: Adapted the Node MCP runtime to the sidecar without changing the five-tool surface.
- [x] 2026-07-22: Added protocol, permission, volatile-storage, no-history-download, and no-auto-reconnect tests.
- [x] 2026-07-22: Ran Node checks/tests/audit and Go formatting/vetting/race tests.
- [ ] Review the diff, build the sidecar, and install an explicitly experimental plugin version.
- [ ] Make exactly one controlled pairing attempt and record the observed status.

## Surprises & Discoveries

- TataBot's May 25 plan records the same WhatsApp error, `can't link new devices right now`, but its local SQLite credential database was modified on June 4 and contains a linked device plus session keys. This suggests a later pairing succeeded for that separate TataBot account; it does not prove the user's current account will pair.
- The stock whatsmeow client enables automatic reconnect by default. The experiment must explicitly disable it so a rejected pairing cannot create the rapid retry loop observed in Baileys.
- A successful WhatsApp pairing requires one protocol-mandated reconnect after the phone accepts the QR. The sidecar permits exactly this one login transition while keeping general and initial automatic reconnect disabled.
- The TataBot bridge logs the raw QR payload and its local credential database has mode `0644`. Neither behavior is acceptable for this relay.
- The first adversarial pass found that the legacy terminal auth/status scripts assumed Baileys return objects and would misreport the new runtime. They were rewritten against the transport-neutral runtime before installation.
- The whatsmeow SQL store offers optional decrypted-event and outgoing retry buffers, and its default history behavior downloads history-sync payloads. The experiment now disables both plaintext buffers and automatic history downloads explicitly rather than relying on defaults.
- `npm audit` reports two moderate findings in `@hono/node-server <2.0.5`, pulled by the latest `@modelcontextprotocol/sdk 1.29.0`. The affected optional HTTP static-file path is not reachable because this plugin imports and uses only the stdio server transport on Linux. The upstream SDK currently has no dependency update that removes the finding, so forcing a major transitive override would add more compatibility risk than it removes here.

## Decision Log

Decision: Keep the Node MCP server and run whatsmeow as a child sidecar rather than expose an unauthenticated HTTP service.

Rationale: A child process inherits private pipes, terminates with the MCP, requires no listening port or daemon, and lets the existing bounded in-memory store and MCP schemas remain intact.

Date/Author: 2026-07-22 / Codex

Decision: Do not reuse TataBot's WhatsApp session database.

Rationale: The database is a bearer credential for a different operational identity. The experiment needs a fresh database under the relay's existing private auth directory and must not disturb TataBot.

Date/Author: 2026-07-22 / Codex

Decision: Disable all automatic reconnect behavior during the experiment.

Rationale: The purpose is to observe one clean registration attempt without increasing an account-side cooldown or obscuring the initial failure reason.

Date/Author: 2026-07-22 / Codex

## Outcomes & Retrospective

The implementation is complete and passes five Node tests, Go unit tests under the race detector, `go vet`, clean-install dependency reconstruction, a direct sidecar status smoke test, and an MCP initialize/list/status smoke test. Installation and the one live pairing outcome remain pending.

## Context and Orientation

The repository is a security-reduced fork of `abuiles/codex-whatsapp-relay`. `plugins/whatsapp-relay/scripts/mcp-server.mjs` registers exactly five tools: start authentication, authentication status, list chats, read bounded recent messages, and send an explicit text. `plugins/whatsapp-relay/scripts/store.mjs` persists only chat/contact metadata and holds message bodies in process memory. `plugins/whatsapp-relay/scripts/runtime.mjs` currently implements the transport using Baileys. `plugins/whatsapp-relay/scripts/mcp-launcher.mjs` loads the reviewed checkout from the user's Codex plugin directory.

The new sidecar will live under `plugins/whatsapp-relay/whatsmeow-sidecar`. A sidecar is a child process dedicated to WhatsApp transport. It will accept one JSON object per line on standard input and emit responses or events as one JSON object per line on standard output. Its standard error may contain operational diagnostics but must never contain QR payloads, message bodies, phone numbers, JIDs, or credentials.

## Plan of Work

Add a small Go module pinned to the same reviewed whatsmeow revision used by TataBot. The sidecar will initialize an SQLite credential database, enforce `0700` on its parent directory and `0600` on the database and side files, disable whatsmeow automatic reconnect, and implement commands for status, start-auth, connect-saved-session, send-text, list-groups, and shutdown. Whatsmeow events will be normalized into status, QR, chat, and message events. It will not download media, synchronize full message history, open a port, run in the background, or automatically answer messages.

Replace the Baileys-specific runtime internals with a Node client for the child protocol. Preserve the existing `WhatsAppRuntime` interface used by the MCP server and reuse `WhatsAppStore` for metadata and volatile message bodies. Rendering the QR remains in Node so the raw QR travels only through the private child pipe. Sending continues to require an exact resolved chat and explicit MCP invocation.

Update package metadata, README, changelog, plugin metadata, and skill text to identify the experimental transport and its unofficial status. Remove Baileys-only dependencies after the Node transport no longer imports them. Add unit tests that run against a fake sidecar so ordinary tests do not connect to WhatsApp.

## Concrete Steps

From the repository root:

    gofmt -w plugins/whatsapp-relay/whatsmeow-sidecar
    GOCACHE=/tmp/whatsapp-relay-go-cache go test ./...
    npm ci --ignore-scripts --no-fund --no-audit
    npm run check
    npm test
    npm audit --package-lock-only --ignore-scripts

Build the reviewed sidecar locally into an ignored binary path:

    npm run build:whatsmeow

Only after all checks pass, install the experimental plugin without deleting the previously installed release. Start the MCP, call `whatsapp_auth_status`, then call `whatsapp_start_auth` once. Scan the generated QR once and call `whatsapp_auth_status` to capture the outcome. Stop after either connection or rejection; do not retry automatically.

## Validation and Acceptance

Offline acceptance requires: only the five approved MCP tools are registered; Node tests prove message bodies are absent from disk; Go tests prove credential paths are hardened, malformed commands fail closed, URL previews are not generated because the sidecar sends plain conversation text, and automatic reconnect is disabled; the sidecar protocol does not emit raw message content to stderr; Node audit findings are either removed or shown unreachable in the stdio-only configuration; and Go source is formatted and vetted.

Live acceptance is one of two conclusive outcomes. Success means WhatsApp reports the linked device, the MCP reports `connected`, group metadata becomes available, and no second pairing attempt occurs. A useful failure means the MCP captures a stable rejection/disconnect status from one attempt without retrying, confirming that whatsmeow does not bypass the account-side restriction.

## Idempotence and Recovery

Tests use temporary directories and fake transports. Rebuilding the binary is safe. The experimental session database is separate from both TataBot and the old Baileys auth directory. To roll back, disable the experimental plugin and reinstall tag `v0.4.3-hardened.6`; do not delete credential files unless the user explicitly requests unlinking or cleanup. If pairing fails, stop the MCP and leave the account untouched until the cooldown expires.

## Artifacts and Notes

Baseline commit: `887a027384309f6af1f0dcce06fd665530a7b845` (`v0.4.3-hardened.6`). TataBot reference dependency: `go.mau.fi/whatsmeow v0.0.0-20260525123251-933deb5f2ee9`. Baseline Node tests previously passed, and TataBot's Go bridge tests passed locally on 2026-07-22.

Validation evidence on 2026-07-22: `npm run check` passed; five Node tests passed; Go tests passed under `-race`; `go vet ./...` passed; `npm ls --depth=0` contains only the three intended direct Node packages; the sidecar smoke returned protocol version 1 with `status=idle` and no credentials; the MCP smoke negotiated protocol `2025-06-18`, listed exactly five tools, and reported the new SQLite auth path. Credential smoke files were `0700`/`0600`.

## Interfaces and Dependencies

The Node MCP layer continues to depend on `@modelcontextprotocol/sdk` and `zod`. The new Go module depends directly on `go.mau.fi/whatsmeow`, `github.com/mattn/go-sqlite3`, and `google.golang.org/protobuf`, pinned through `go.mod` and `go.sum`. The sidecar command protocol is private to this repository and versioned as `protocol: 1`. No network listener, browser, Cloud API, daemon, media downloader, or phone-to-Codex controller is introduced.
