import net from "node:net";

import { relaySocketFile } from "./paths.mjs";

const DEFAULT_TIMEOUT_MS = 25_000;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

export class RelayClient {
  constructor({ socketPath = relaySocketFile, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    this.socketPath = socketPath;
    this.timeoutMs = timeoutMs;
    this.nextId = 1;
  }

  request(method, params = {}) {
    const id = this.nextId++;
    const payload = `${JSON.stringify({ id, method, params })}\n`;

    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ path: this.socketPath });
      let settled = false;
      let buffered = "";
      let receivedBytes = 0;
      const timeout = setTimeout(() => {
        finish(new Error(`Timed out waiting for WhatsApp relay method ${method}.`));
      }, this.timeoutMs);

      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        socket.destroy();
        if (error) reject(error);
        else resolve(value);
      };

      socket.setEncoding("utf8");
      socket.once("connect", () => socket.write(payload));
      socket.on("data", (chunk) => {
        receivedBytes += Buffer.byteLength(chunk);
        if (receivedBytes > MAX_RESPONSE_BYTES) {
          finish(new Error("WhatsApp relay response exceeded the private protocol limit."));
          return;
        }
        buffered += chunk;
        const newline = buffered.indexOf("\n");
        if (newline < 0) return;
        let response;
        try {
          response = JSON.parse(buffered.slice(0, newline));
        } catch {
          finish(new Error("WhatsApp relay returned an invalid response."));
          return;
        }
        if (response.id !== id) {
          finish(new Error("WhatsApp relay returned a mismatched response."));
        } else if (!response.ok) {
          const error = new Error(response.error?.message || "WhatsApp relay request failed.");
          error.candidates = response.error?.candidates;
          finish(error);
        } else {
          finish(null, response.result);
        }
      });
      socket.once("error", (error) => {
        const message =
          error.code === "ENOENT" || error.code === "ECONNREFUSED"
            ? "The persistent WhatsApp relay service is not running. Start codex-whatsapp-relay.service."
            : "Could not connect to the persistent WhatsApp relay service.";
        finish(new Error(message));
      });
      socket.once("end", () => {
        if (!settled) finish(new Error("WhatsApp relay closed before responding."));
      });
    });
  }
}
