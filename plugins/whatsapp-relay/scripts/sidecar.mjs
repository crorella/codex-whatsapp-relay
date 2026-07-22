import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import readline from "node:readline";

import {
  ensureRuntimeDirs,
  hardenAuthState,
  sessionDbFile,
  sidecarBinary
} from "./paths.mjs";

const PROTOCOL_VERSION = 1;

export function parseProtocolLine(line) {
  const envelope = JSON.parse(line);
  if (!envelope || envelope.protocol !== PROTOCOL_VERSION) {
    throw new Error("Unsupported whatsmeow sidecar protocol.");
  }
  if (envelope.id !== undefined) {
    if (!Number.isInteger(envelope.id) || envelope.id <= 0) {
      throw new Error("Invalid whatsmeow sidecar response id.");
    }
    return { type: "response", envelope };
  }
  if (typeof envelope.event !== "string" || !envelope.event) {
    throw new Error("Invalid whatsmeow sidecar event.");
  }
  return { type: "event", envelope };
}

export class SidecarClient extends EventEmitter {
  constructor({
    binaryPath = process.env.WHATSAPP_SIDECAR_BIN || sidecarBinary,
    sessionPath = process.env.WHATSAPP_SESSION_DB || sessionDbFile,
    spawnImpl = spawn,
    requestTimeoutMs = 30_000
  } = {}) {
    super();
    this.binaryPath = binaryPath;
    this.sessionPath = sessionPath;
    this.spawnImpl = spawnImpl;
    this.requestTimeoutMs = requestTimeoutMs;
    this.child = null;
    this.nextId = 1;
    this.pending = new Map();
    this.startPromise = null;
    this.stopping = false;
  }

  async start() {
    if (this.child) {
      return;
    }
    if (this.startPromise) {
      return this.startPromise;
    }
    this.startPromise = this.#startInternal().finally(() => {
      this.startPromise = null;
    });
    return this.startPromise;
  }

  async #startInternal() {
    await ensureRuntimeDirs();
    await fs.access(this.binaryPath, fsConstants.X_OK);
    const child = this.spawnImpl(this.binaryPath, [], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        WHATSAPP_SESSION_DB: this.sessionPath
      }
    });
    this.child = child;
    this.stopping = false;

    const lines = readline.createInterface({ input: child.stdout });
    lines.on("line", (line) => this.#handleLine(line));

    // The sidecar uses stderr only for fixed, non-sensitive diagnostics. Do not
    // forward raw child output into Codex logs.
    child.stderr.on("data", () => {
      this.emit("diagnostic", { at: new Date().toISOString() });
    });
    child.once("error", () => {
      this.#failPending(new Error("Failed to start the whatsmeow sidecar."));
    });
    child.once("exit", (code, signal) => {
      const wasStopping = this.stopping;
      this.child = null;
      lines.close();
      this.#failPending(
        new Error(
          wasStopping
            ? "The whatsmeow sidecar stopped."
            : `The whatsmeow sidecar exited unexpectedly (${code ?? signal ?? "unknown"}).`
        )
      );
      this.emit("exit", { code, signal, expected: wasStopping });
    });

    await this.request("status", {}, { skipStart: true });
    await hardenAuthState();
  }

  async request(method, params = {}, { skipStart = false } = {}) {
    if (!skipStart) {
      await this.start();
    }
    if (!this.child?.stdin?.writable) {
      throw new Error("The whatsmeow sidecar is not running.");
    }

    const id = this.nextId++;
    const payload = JSON.stringify({ id, method, params });
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for whatsmeow method ${method}.`));
      }, this.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timeout });
      this.child.stdin.write(`${payload}\n`, (error) => {
        if (!error) {
          return;
        }
        const pending = this.pending.get(id);
        if (pending) {
          clearTimeout(pending.timeout);
          this.pending.delete(id);
          pending.reject(new Error("Failed to write to the whatsmeow sidecar."));
        }
      });
    });
  }

  async stop() {
    if (!this.child) {
      return;
    }
    this.stopping = true;
    try {
      await this.request("shutdown", {}, { skipStart: true });
    } catch {
      // Closing stdin still causes a clean sidecar shutdown.
    }
    this.child?.stdin?.end();
  }

  #handleLine(line) {
    let parsed;
    try {
      parsed = parseProtocolLine(line);
    } catch {
      this.emit("protocol_error", { at: new Date().toISOString() });
      return;
    }
    const { envelope } = parsed;
    if (parsed.type === "event") {
      this.emit(envelope.event, envelope.data ?? {});
      this.emit("event", envelope);
      return;
    }
    const pending = this.pending.get(envelope.id);
    if (!pending) {
      return;
    }
    clearTimeout(pending.timeout);
    this.pending.delete(envelope.id);
    if (envelope.ok) {
      pending.resolve(envelope.result);
    } else {
      pending.reject(new Error(envelope.error || "whatsmeow_request_failed"));
    }
  }

  #failPending(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
