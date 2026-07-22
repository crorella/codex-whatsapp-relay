import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { WhatsAppRuntime } from "./runtime.mjs";
import { WhatsAppStore } from "./store.mjs";

class FakeSidecar extends EventEmitter {
  constructor() {
    super();
    this.calls = [];
  }

  async start() {}

  async request(method, params = {}) {
    this.calls.push({ method, params });
    if (method === "status") {
      return { status: "idle", hasCredentials: false };
    }
    if (method === "start_auth") {
      queueMicrotask(() => {
        this.emit("qr", { payload: "test-qr-payload", timeoutSeconds: 60 });
      });
      return { status: "connecting", hasCredentials: false };
    }
    if (method === "shutdown") {
      return { stopping: true };
    }
    throw new Error(`unexpected method ${method}`);
  }

  async stop() {}
}

test("controlled auth returns one QR and refuses a retry after disconnect", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "whatsapp-runtime-"));
  const sidecar = new FakeSidecar();
  const store = new WhatsAppStore(path.join(tempDir, "store.json"));
  const runtime = new WhatsAppRuntime({ sidecar, store });
  try {
    await runtime.initialize();
    const result = await runtime.startAuthFlow();
    assert.equal(result.status, "awaiting_qr_scan");
    assert.match(result.qrText, /[▀▄█]/);
    assert.equal(sidecar.calls.filter(({ method }) => method === "start_auth").length, 1);

    runtime.state.currentQrText = null;
    sidecar.emit("status", {
      status: "disconnected",
      hasCredentials: false,
      lastDisconnect: "pairing_rejected"
    });
    await assert.rejects(
      runtime.startAuthFlow(),
      /controlled pairing attempt already ended/
    );
    assert.equal(sidecar.calls.filter(({ method }) => method === "start_auth").length, 1);
  } finally {
    await runtime.close();
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
