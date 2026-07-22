import { WhatsAppRuntime } from "./runtime.mjs";

const runtime = new WhatsAppRuntime();

try {
  await runtime.initialize();
  process.stdout.write("Starting one controlled WhatsApp QR authentication attempt...\n");
  process.stdout.write(
    "Open WhatsApp on your phone, then go to Settings -> Linked Devices -> Link a Device.\n"
  );

  const result = await runtime.startAuthFlow();
  if (result.qrText) {
    process.stdout.write(`\n${result.qrText}\n\n`);
  }
  await runtime.waitForConnection(5 * 60_000);
  const user = runtime.summary().user?.id ?? "unknown";
  process.stdout.write(`\nAuthenticated successfully as ${user}.\n`);
} catch (error) {
  process.stderr.write(`\nAuthentication failed: ${error.message}\n`);
  process.exitCode = 1;
} finally {
  await runtime.close().catch(() => {});
}
