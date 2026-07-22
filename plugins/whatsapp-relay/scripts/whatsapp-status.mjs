import { WhatsAppRuntime } from "./runtime.mjs";

const runtime = new WhatsAppRuntime({
  logLevel: process.env.WHATSAPP_LOG_LEVEL ?? "error"
});

if (!runtime.hasSavedCreds()) {
  process.stdout.write("status: not_authenticated\n");
  process.stdout.write("next: use `whatsapp_start_auth` in Codex or run `npm run whatsapp:auth`\n");
  process.exit(0);
}

await runtime.start({ printQrToTerminal: false });

try {
  const socket = await runtime.waitForConnection(20_000);
  process.stdout.write("status: connected\n");
  process.stdout.write(`user: ${socket.user?.id ?? "unknown"}\n`);
  process.exit(0);
} catch (error) {
  const summary = runtime.summary();
  process.stdout.write(`status: ${summary.status}\n`);
  if (summary.lastDisconnect?.label) {
    process.stdout.write(`last_disconnect: ${summary.lastDisconnect.label}\n`);
  }
  process.stdout.write("next: rerun WhatsApp linked-device authentication\n");
  process.exit(1);
}
