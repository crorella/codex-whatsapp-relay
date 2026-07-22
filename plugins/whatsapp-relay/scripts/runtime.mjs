import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";

import { authDir, ensureRuntimeDirs, runtimeFile, storeFile } from "./paths.mjs";
import { SidecarClient } from "./sidecar.mjs";
import { WhatsAppStore } from "./store.mjs";

const require = createRequire(import.meta.url);
const QRCode = require("qrcode-terminal/vendor/QRCode");
const QRErrorCorrectLevel = require("qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel");

const VERTICAL_BLOCKS = {
  "00": " ",
  "10": "▀",
  "01": "▄",
  "11": "█"
};

function buildQrMatrix(value, quietZone = 2) {
  const qr = new QRCode(-1, QRErrorCorrectLevel.L);
  qr.addData(value);
  qr.make();
  const moduleCount = qr.getModuleCount();
  const size = moduleCount + quietZone * 2;
  const evenSize = size % 2 === 0 ? size : size + 1;
  const matrix = [];
  for (let row = 0; row < evenSize; row += 1) {
    const currentRow = [];
    for (let col = 0; col < evenSize; col += 1) {
      const qrRow = row - quietZone;
      const qrCol = col - quietZone;
      const inBounds =
        qrRow >= 0 && qrRow < moduleCount && qrCol >= 0 && qrCol < moduleCount;
      currentRow.push(inBounds ? qr.modules[qrRow][qrCol] : false);
    }
    matrix.push(currentRow);
  }
  return matrix;
}

export function renderCompactQr(value) {
  const matrix = buildQrMatrix(value);
  const rows = [];
  for (let row = 0; row < matrix.length; row += 2) {
    let line = "";
    const lowerRow = matrix[row + 1] ?? [];
    for (let col = 0; col < matrix[row].length; col += 1) {
      const upperDark = matrix[row][col] ? "1" : "0";
      const lowerDark = lowerRow[col] ? "1" : "0";
      line += VERTICAL_BLOCKS[`${upperDark}${lowerDark}`];
    }
    rows.push(line);
  }
  return rows.join("\n");
}

export class WhatsAppRuntime {
  constructor({
    sidecar = new SidecarClient(),
    store = new WhatsAppStore(storeFile)
  } = {}) {
    this.store = store;
    this.events = new EventEmitter();
    this.sidecar = sidecar;
    this.startPromise = null;
    this.authAttempted = false;
    this.initialized = false;
    this.state = {
      status: "idle",
      hasCreds: false,
      user: null,
      lastQrAt: null,
      currentQrText: null,
      lastDisconnect: null,
      authDir,
      runtimeFile
    };
    this.#bindSidecar();
  }

  #bindSidecar() {
    this.sidecar.on("status", (status) => {
      this.state.status = status.status ?? this.state.status;
      this.state.hasCreds = Boolean(status.hasCredentials);
      this.state.user = status.user ? { id: status.user } : null;
      this.state.lastDisconnect = status.lastDisconnect
        ? { label: status.lastDisconnect, at: new Date().toISOString() }
        : null;
      if (this.state.status === "connected") {
        this.state.currentQrText = null;
        this.store.updateMeta({
          lastConnection: {
            openedAt: new Date().toISOString(),
            user: this.state.user
          }
        });
      }
      this.events.emit("connection.update", this.summary());
    });

    this.sidecar.on("qr", ({ payload }) => {
      if (typeof payload !== "string" || !payload) {
        return;
      }
      this.state.lastQrAt = new Date().toISOString();
      this.state.status = "awaiting_qr_scan";
      this.state.currentQrText = renderCompactQr(payload);
      this.events.emit("connection.update", this.summary());
    });

    this.sidecar.on("chat", (chat) => {
      this.#ingestChat(chat);
    });

    this.sidecar.on("message", (message) => {
      this.#ingestChat({
        id: message.chatId,
        name: message.pushName,
        isGroup: message.chatId?.endsWith("@g.us"),
        timestamp: message.timestamp
      });
      this.store.ingestMessage({
        key: {
          id: message.id,
          remoteJid: message.chatId,
          participant: message.senderId ?? null,
          fromMe: Boolean(message.fromMe)
        },
        messageTimestamp: message.timestamp,
        pushName: message.pushName ?? null,
        message: { conversation: message.text ?? "" }
      });
      this.events.emit("messages.upsert", { messages: [message] });
    });

    this.sidecar.on("exit", ({ expected }) => {
      if (!expected) {
        this.state.status = "disconnected";
        this.state.lastDisconnect = {
          label: "sidecar_exited",
          at: new Date().toISOString()
        };
      }
    });
  }

  #ingestChat(chat) {
    if (!chat?.id) {
      return;
    }
    this.store.upsertChat({
      id: chat.id,
      name: chat.name ?? null,
      subject: chat.name ?? null,
      timestamp: chat.timestamp ?? null
    });
  }

  async initialize() {
    if (this.initialized) {
      return;
    }
    await ensureRuntimeDirs();
    await this.store.load();
    await this.sidecar.start();
    const status = await this.sidecar.request("status");
    this.state.status = status.status ?? "idle";
    this.state.hasCreds = Boolean(status.hasCredentials);
    this.state.user = status.user ? { id: status.user } : null;
    this.initialized = true;
  }

  hasSavedCreds() {
    return this.state.hasCreds;
  }

  summary() {
    return {
      ...this.state,
      recentChatCount: Object.keys(this.store.data.chats ?? {}).length
    };
  }

  async start() {
    if (this.state.status === "connected") {
      return this;
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
    await this.initialize();
    this.state.status = "connecting";
    if (this.hasSavedCreds()) {
      await this.sidecar.request("connect_saved");
    } else {
      this.authAttempted = true;
      await this.sidecar.request("start_auth");
    }
    return this;
  }

  on(eventName, listener) {
    this.events.on(eventName, listener);
    return () => this.events.off(eventName, listener);
  }

  async waitForConnection(timeoutMs = 20_000) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      if (this.state.status === "connected") {
        return this;
      }
      if (this.state.status === "logged_out") {
        throw new Error("WhatsApp session was logged out. Re-run the QR auth flow.");
      }
      if (this.state.status === "disconnected") {
        throw new Error(
          `WhatsApp disconnected without retrying (${this.state.lastDisconnect?.label ?? "unknown"}).`
        );
      }
      await delay(250);
    }
    throw new Error(
      `Timed out waiting for WhatsApp to connect. Current status: ${this.state.status}.`
    );
  }

  async ensureConnected(timeoutMs = 20_000) {
    if (this.state.status === "connected") {
      return this;
    }
    if (!this.hasSavedCreds()) {
      throw new Error(
        "WhatsApp is not authenticated yet. Call `whatsapp_start_auth` and scan the QR code first."
      );
    }
    await this.start();
    return this.waitForConnection(timeoutMs);
  }

  async startAuthFlow(timeoutMs = 20_000) {
    if (this.state.status === "connected") {
      return { status: "connected", user: this.state.user, qrText: null };
    }
    if (this.state.currentQrText) {
      return {
        status: "awaiting_qr_scan",
        user: null,
        qrText: this.state.currentQrText
      };
    }
    if (this.authAttempted && this.state.status === "disconnected") {
      throw new Error(
        "The controlled pairing attempt already ended. The relay will not retry automatically."
      );
    }
    await this.start();
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      if (this.state.status === "connected") {
        return { status: "connected", user: this.state.user, qrText: null };
      }
      if (this.state.currentQrText) {
        return {
          status: "awaiting_qr_scan",
          user: null,
          qrText: this.state.currentQrText
        };
      }
      if (this.state.status === "disconnected") {
        throw new Error(
          `WhatsApp rejected or ended the controlled pairing attempt (${this.state.lastDisconnect?.label ?? "unknown"}).`
        );
      }
      await delay(250);
    }
    throw new Error(
      `Timed out waiting for WhatsApp auth to start. Current status: ${this.state.status}.`
    );
  }

  async refreshChats() {
    await this.ensureConnected();
    const chats = await this.sidecar.request("list_chats");
    for (const chat of chats ?? []) {
      this.#ingestChat(chat);
    }
    return this.store.listChats({ limit: 100 });
  }

  async sendText(chatId, text) {
    await this.ensureConnected();
    return this.sidecar.request("send_text", { chatId, text });
  }

  async close() {
    await this.store.save();
    await this.sidecar.stop();
  }
}
