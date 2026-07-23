# Keep WhatsApp Reception Alive Between Codex Requests

This ExecPlan is a living document. Keep `Progress`, `Surprises & Discoveries`, `Decision Log`, and `Outcomes & Retrospective` current as work proceeds.

## Purpose / Big Picture

After this change, the WhatsApp relay will keep one authenticated connection alive outside any individual Codex MCP process. A message arriving after Codex sends text will remain available in a bounded in-memory buffer so a later Codex request can read and summarize the response. The observable acceptance flow is: start the user service, send a test message through the MCP, receive a reply while no MCP client is attached, reconnect an MCP client, and read that reply without relinking the account.

## Progress

- [x] 2026-07-22: Confirmed the current per-MCP runtime loses its volatile buffer when the MCP client exits.
- [x] 2026-07-22: Chose a single-user Unix-socket service with a private, bounded message cache.
- [x] 2026-07-22: Implemented the persistent service protocol and thin MCP client.
- [x] 2026-07-22: Added service installation, lifecycle documentation, and revised repository safety rules.
- [x] 2026-07-22: Added and passed unit, integration, permission, expiry, restart-persistence, and regression tests.
- [x] 2026-07-22: Installed plugin `0.4.3-hardened.8-experimental.1` and enabled the user service without replacing WhatsApp credentials.
- [x] 2026-07-22: Verified live saved-session reconnection and MCP access through a separate client; cross-client retention is covered by integration tests and awaits the next real inbound message for an end-to-end observation.

## Surprises & Discoveries

- The MCP itself already reconnects with saved credentials, but WhatsApp did not replay an earlier response when a later MCP process connected. Persistence of the connection, not merely persistence of credentials, is required.
- The repository originally prohibited background daemons. The user has now explicitly requested the behavior that requires one, so the safety boundary must be revised narrowly rather than bypassed implicitly.
- The user explicitly preferred functional history access over volatile-only storage and authorized temporary local message persistence. The original no-body-on-disk constraint is therefore obsolete for this fork.
- The managed sandbox rejects Unix socket creation with `EPERM`; the same test passes outside that socket restriction. This is an execution-environment limitation, not a relay failure.
- A second service instance could otherwise unlink the first instance's live socket. Startup now probes an existing same-user socket and refuses to replace it when active.
- This host's user systemd manager rejects capability and mount-namespace hardening with `status=218/CAPABILITIES`. The unit therefore relies on same-user execution, `NoNewPrivileges`, `UMask=0077`, and explicit `0700`/`0600` paths instead of unsupported namespace directives.

## Decision Log

Decision: Run exactly one persistent Node service that owns `WhatsAppRuntime` and its whatsmeow sidecar, and let MCP processes communicate with it over a Unix-domain socket.

Rationale: This retains one WhatsApp connection and one bounded in-memory buffer while avoiding a TCP listener, duplicate sessions, or message bodies on disk. Unix socket permissions can restrict access to the current OS user.

Date/Author: 2026-07-22 / Codex

Decision: Keep inbound messages passive data only.

Rationale: The service may buffer messages, but it must never interpret them, launch Codex, call tools, or send replies. Sending remains an explicit MCP call authorized by the user.

Date/Author: 2026-07-22 / Codex

Decision: Persist a bounded seven-day message cache locally with mode `0600`.

Rationale: A persistent connection alone can still lose messages across service restarts. The user explicitly authorized temporary local storage and wants reliable reading. Seven days, 200 messages per chat, and 5,000 messages overall provide useful continuity without becoming an unlimited archive.

Date/Author: 2026-07-22 / Codex

## Outcomes & Retrospective

The implementation passes 11 Node tests, Node syntax checks, Go race tests, and Go vet. Plugin `0.4.3-hardened.8-experimental.1` is installed globally. `codex-whatsapp-relay.service` is enabled and active, reused the existing credentials without QR authentication, and reports `connected`. Runtime directories and files were verified as `0700`/`0600`. A separate MCP client reached the persistent service and read the Wut cache successfully; it was empty because the earlier reply, if any, arrived before this service existed and cannot be reconstructed.

## Context and Orientation

`plugins/whatsapp-relay/scripts/runtime.mjs` owns a `WhatsAppRuntime`, starts the Go whatsmeow sidecar, and keeps message bodies in the `WhatsAppStore.messages` map. Today `plugins/whatsapp-relay/scripts/mcp-server.mjs` creates that runtime directly, so closing the MCP destroys the map. `store.json` contains chat metadata. The revised store also writes a bounded, expiring `messages.json` cache. The linked-device credentials live in `plugins/whatsapp-relay/data/auth/whatsmeow.db` and must be reused without modification.

The new relay service is a background process started as a systemd user service. It will own the runtime and listen only on a Unix socket under the plugin's private `data/run/` directory. Each MCP process will be a stateless client of this service. Message bodies are cached locally for seven days in a mode-`0600` file and remain subject to the existing per-chat and global limits.

## Plan of Work

Add a small JSON-lines RPC server and client under `plugins/whatsapp-relay/scripts/`. The server validates method names and arguments, calls the existing runtime and store, and returns sanitized errors. It supports status, controlled authentication, chat listing, bounded message reading, explicit text sending, and shutdown. The client opens the private socket for one request and enforces timeouts and response-size limits.

Refactor the MCP server so its five existing tools use the RPC client instead of creating a runtime. Keep tool names and schemas stable. Update the terminal auth and status helpers to use the same service. Add a systemd user unit template plus an idempotent installer that resolves the installed checkout path, writes the unit under `~/.config/systemd/user/`, reloads systemd, and enables the service. Installation must not delete or rewrite the existing WhatsApp database.

Revise repository instructions, plugin metadata, skill text, README, and changelog to describe the singleton service and precise privacy boundary. Bump the experimental version so the installed plugin is auditable.

## Concrete Steps

From `work/codex-whatsapp-relay`:

    npm run check
    npm test
    GOCACHE=/tmp/whatsapp-relay-go-cache go test -C plugins/whatsapp-relay/whatsmeow-sidecar -race ./...
    GOCACHE=/tmp/whatsapp-relay-go-cache go vet -C plugins/whatsapp-relay/whatsmeow-sidecar ./...
    npm audit --package-lock-only --ignore-scripts

After offline tests, build and stage the plugin, install the systemd user unit, and inspect:

    systemctl --user status codex-whatsapp-relay.service
    stat plugins/whatsapp-relay/data/run/relay.sock

Then call MCP status/list/read through two separate client processes. The second process must observe messages buffered by the service before it connected.

## Validation and Acceptance

Acceptance requires all existing tests plus new tests proving: the socket directory is `0700` and socket is `0600`; malformed or oversized RPC requests fail closed; only the approved five MCP tools remain; message bodies appear only in the private expiring cache and never in service logs; a message ingested before one RPC client disconnects is readable by a later client and after a service restart; sends still require an exact chat and explicit call; and service installation is idempotent.

Live acceptance requires the installed service to report `connected` using the existing account with no QR flow. A response received after an MCP command exits must be returned by a later read call.

## Idempotence and Recovery

The service installer may be rerun safely. It rewrites only its own user unit and never deletes credentials. If the new service fails, stop and disable `codex-whatsapp-relay.service`, restore the previous cached plugin version, and start the old per-MCP runtime. Existing `whatsmeow.db` credentials remain reusable. Socket cleanup is limited to the exact private socket path after proving it is a socket owned by the current user.

## Artifacts and Notes

Baseline is commit `d9db829219dc552e68063b164cecd27ba56c8fea` on `experiment/whatsmeow-transport`. The linked account was live-verified as connected before this change. A test send to Wut succeeded, but a later MCP process returned an empty message buffer, which is the motivating failure. Offline evidence: 11 Node tests passed; Go `-race` tests and `go vet` passed. Live evidence: the installed service is `active` and `enabled`, status is `connected`, the socket and caches are mode `0600`, and an independently launched MCP client returned the new seven-day cache contract.

## Interfaces and Dependencies

The service uses Node's built-in `net` module and existing `WhatsAppRuntime`; no new runtime dependency or TCP port is introduced. The RPC protocol is private JSON-lines over a Unix socket, with one request and one response per connection. systemd user services provide login-session lifecycle and restart behavior. The Go whatsmeow sidecar and SQLite credential database remain unchanged.
