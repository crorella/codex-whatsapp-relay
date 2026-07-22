import { WhatsAppRuntime } from "./runtime.mjs";

const runtime = new WhatsAppRuntime();

try {
  await runtime.initialize();
  if (!runtime.hasSavedCreds()) {
    process.stdout.write("status: not_authenticated\n");
    process.stdout.write("next: use `whatsapp_start_auth` in Codex or run `npm run whatsapp:auth`\n");
  } else {
    await runtime.start();
    await runtime.waitForConnection(20_000);
    process.stdout.write("status: connected\n");
    process.stdout.write(`user: ${runtime.summary().user?.id ?? "unknown"}\n`);
  }
} catch (error) {
  const summary = runtime.summary();
  process.stdout.write(`status: ${summary.status}\n`);
  if (summary.lastDisconnect?.label) {
    process.stdout.write(`last_disconnect: ${summary.lastDisconnect.label}\n`);
  }
  process.stdout.write(`error: ${error.message}\n`);
  process.exitCode = 1;
} finally {
  await runtime.close().catch(() => {});
}
