import { RelayClient } from "./relay-client.mjs";

const relay = new RelayClient();

try {
  const summary = await relay.request("status");
  if (!summary.hasCreds) {
    process.stdout.write("status: not_authenticated\n");
    process.stdout.write("next: use `whatsapp_start_auth` in Codex or run `npm run whatsapp:auth`\n");
  } else {
    process.stdout.write(`status: ${summary.status}\n`);
    process.stdout.write(`user: ${summary.user?.id ?? "unknown"}\n`);
  }
} catch (error) {
  process.stdout.write("status: service_unavailable\n");
  process.stdout.write(`error: ${error.message}\n`);
  process.exitCode = 1;
}
