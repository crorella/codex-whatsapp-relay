import { setTimeout as delay } from "node:timers/promises";

import { RelayClient } from "./relay-client.mjs";

const relay = new RelayClient();

try {
  process.stdout.write("Starting one controlled WhatsApp QR authentication attempt...\n");
  process.stdout.write(
    "Open WhatsApp on your phone, then go to Settings -> Linked Devices -> Link a Device.\n"
  );

  const result = await relay.request("start_auth");
  if (result.qrText) {
    process.stdout.write(`\n${result.qrText}\n\n`);
  }
  const startedAt = Date.now();
  let summary = await relay.request("status");
  while (summary.status !== "connected" && Date.now() - startedAt < 5 * 60_000) {
    if (summary.status === "disconnected" || summary.status === "logged_out") {
      throw new Error(`WhatsApp authentication ended with status ${summary.status}.`);
    }
    await delay(500);
    summary = await relay.request("status");
  }
  if (summary.status !== "connected") throw new Error("Timed out waiting for WhatsApp to connect.");
  const user = summary.user?.id ?? "unknown";
  process.stdout.write(`\nAuthenticated successfully as ${user}.\n`);
} catch (error) {
  process.stderr.write(`\nAuthentication failed: ${error.message}\n`);
  process.exitCode = 1;
}
