import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";

import { Boom } from "@hapi/boom";
import makeWASocket, {
  Browsers,
  DisconnectReason,
  fetchLatestWaWebVersion,
  useMultiFileAuthState
} from "@whiskeysockets/baileys";
import pino from "pino";

import {
  authDir,
  credsFile,
  ensureRuntimeDirs,
  hardenAuthState,
  runtimeFile,
  storeFile
} from "./paths.mjs";
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
      const isInBounds =
        qrRow >= 0 &&
        qrRow < moduleCount &&
        qrCol >= 0 &&
        qrCol < moduleCount;

      // QR scanners expect a light quiet zone around the code. Keep the
      // library's dark modules as-is and leave out-of-bounds cells light.
      currentRow.push(isInBounds ? qr.modules[qrRow][qrCol] : false);
    }

    matrix.push(currentRow);
  }

  return matrix;
}

function renderCompactQr(value) {
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

function createLogger(level = "warn") {
  return pino(
    {
      level
    },
    pino.destination(2)
  );
}

function disconnectCode(error) {
  if (!error) {
    return null;
  }

  if (typeof error?.output?.statusCode === "number") {
    return error.output.statusCode;
  }

  if (typeof error?.data?.statusCode === "number") {
    return error.data.statusCode;
  }

  try {
    return new Boom(error).output.statusCode;
  } catch {
    return null;
  }
}

function disconnectLabel(code) {
  switch (code) {
    case DisconnectReason.loggedOut:
      return "logged_out";
    case DisconnectReason.connectionClosed:
      return "connection_closed";
    case DisconnectReason.connectionLost:
      return "connection_lost";
    case DisconnectReason.connectionReplaced:
      return "connection_replaced";
    case DisconnectReason.restartRequired:
      return "restart_required";
    case DisconnectReason.timedOut:
      return "timed_out";
    default:
      return code === null ? "unknown" : `code_${code}`;
  }
}

export class WhatsAppRuntime {
  constructor({ logLevel = "warn" } = {}) {
    this.logger = createLogger(logLevel);
    this.store = new WhatsAppStore(storeFile);
    this.events = new EventEmitter();
    this.socket = null;
    this.startPromise = null;
    this.shouldRenderQr = false;
    this.closing = false;
    this.state = {
      status: "idle",
      hasCreds: existsSync(credsFile),
      user: null,
      lastQrAt: null,
      currentQrText: null,
      lastDisconnect: null,
      authDir,
      runtimeFile
    };
  }

  async initialize() {
    await ensureRuntimeDirs();
    await this.store.load();
  }

  hasSavedCreds() {
    return existsSync(credsFile);
  }

  summary() {
    return {
      ...this.state,
      hasCreds: this.hasSavedCreds(),
      recentChatCount: Object.keys(this.store.data.chats ?? {}).length
    };
  }

  async start({ printQrToTerminal = false, force = false } = {}) {
    this.shouldRenderQr = printQrToTerminal;

    if (this.startPromise && !force) {
      return this.startPromise;
    }

    this.startPromise = this.#startInternal({ printQrToTerminal }).finally(() => {
      this.startPromise = null;
    });

    return this.startPromise;
  }

  async #startInternal({ printQrToTerminal }) {
    await this.initialize();
    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    const setKeys = state.keys.set.bind(state.keys);
    state.keys.set = async (data) => {
      await setKeys(data);
      await hardenAuthState();
    };
    await hardenAuthState();
    const { version } = await fetchLatestWaWebVersion();

    this.state.status = "connecting";
    this.state.hasCreds = this.hasSavedCreds();

    const socket = makeWASocket({
      auth: state,
      version,
      browser: Browsers.macOS("Chrome"),
      printQRInTerminal: false,
      syncFullHistory: false,
      markOnlineOnConnect: false,
      logger: this.logger
    });

    this.socket = socket;
    this.events.emit("socket.ready", socket);

    socket.ev.on("creds.update", async () => {
      await saveCreds();
      await hardenAuthState();
      this.state.hasCreds = this.hasSavedCreds();
      this.events.emit("creds.update", this.summary());
    });

    socket.ev.on("messaging-history.set", (payload) => {
      this.store.ingestHistory(payload);
      this.events.emit("messaging-history.set", payload);
    });

    socket.ev.on("contacts.upsert", (contacts) => {
      for (const contact of contacts) {
        this.store.upsertContact(contact);
      }
      this.events.emit("contacts.upsert", contacts);
    });

    socket.ev.on("contacts.update", (contacts) => {
      for (const contact of contacts) {
        this.store.upsertContact(contact);
      }
      this.events.emit("contacts.update", contacts);
    });

    socket.ev.on("chats.upsert", (chats) => {
      for (const chat of chats) {
        this.store.upsertChat(chat);
      }
      this.events.emit("chats.upsert", chats);
    });

    socket.ev.on("chats.update", (chats) => {
      for (const chat of chats) {
        this.store.upsertChat(chat);
      }
      this.events.emit("chats.update", chats);
    });

    socket.ev.on("messages.upsert", ({ messages }) => {
      for (const message of messages ?? []) {
        this.store.ingestMessage(message);
      }
    });

    socket.ev.on("connection.update", (update) => {
      if (update.qr) {
        this.state.lastQrAt = new Date().toISOString();
        this.state.status = "awaiting_qr_scan";
        this.state.currentQrText = this.#renderQr(update.qr);
        if (printQrToTerminal) {
          process.stdout.write(
            "\nScan this QR code from WhatsApp on your phone.\n\n"
          );
          process.stdout.write(`${this.state.currentQrText}\n`);
          process.stdout.write(
            "\nWhatsApp -> Settings -> Linked Devices -> Link a Device\n\n"
          );
        }
      }

      if (update.connection === "open") {
        this.state.status = "connected";
        this.state.user = socket.user ?? null;
        this.state.lastDisconnect = null;
        this.state.currentQrText = null;
        this.state.hasCreds = this.hasSavedCreds();
        this.store.updateMeta({
          lastConnection: {
            openedAt: new Date().toISOString(),
            user: socket.user ?? null
          }
        });
      }

      if (update.connection === "close") {
        const code = disconnectCode(update.lastDisconnect?.error);
        const label = disconnectLabel(code);
        this.state.status =
          code === DisconnectReason.loggedOut ? "logged_out" : "disconnected";
        if (code === DisconnectReason.loggedOut) {
          this.state.currentQrText = null;
        }
        this.state.lastDisconnect = {
          code,
          label,
          at: new Date().toISOString()
        };
        this.state.user = code === DisconnectReason.loggedOut ? null : this.state.user;

        if (
          !this.closing &&
          code !== DisconnectReason.loggedOut &&
          code !== DisconnectReason.connectionReplaced
        ) {
          setTimeout(() => {
            this.start({ printQrToTerminal: false, force: true }).catch((error) => {
              console.error("failed to reconnect WhatsApp runtime", error);
            });
          }, 1500);
        }
      }

      this.events.emit("connection.update", update);
    });

    socket.ev.on("messages.upsert", (payload) => {
      this.events.emit("messages.upsert", payload);
    });

    return socket;
  }

  on(eventName, listener) {
    this.events.on(eventName, listener);
    return () => {
      this.events.off(eventName, listener);
    };
  }

  async waitForConnection(timeoutMs = 20_000) {
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeoutMs) {
      if (this.state.status === "connected" && this.socket) {
        return this.socket;
      }

      if (this.state.status === "logged_out") {
        throw new Error("WhatsApp session was logged out. Re-run the QR auth flow.");
      }

      await delay(250);
    }

    throw new Error(
      `Timed out waiting for WhatsApp to connect. Current status: ${this.state.status}.`
    );
  }

  async ensureConnected(timeoutMs = 20_000) {
    if (this.state.status === "connected" && this.socket) {
      return this.socket;
    }

    if (!this.hasSavedCreds()) {
      throw new Error(
        "WhatsApp is not authenticated yet. Call `whatsapp_start_auth` and scan the QR code first."
      );
    }

    await this.start({ printQrToTerminal: false });
    return this.waitForConnection(timeoutMs);
  }

  async startAuthFlow(timeoutMs = 20_000) {
    if (this.state.status === "connected" && this.socket) {
      return {
        status: "connected",
        user: this.socket.user ?? this.state.user,
        qrText: null
      };
    }

    if (this.state.currentQrText) {
      return {
        status: "awaiting_qr_scan",
        user: null,
        qrText: this.state.currentQrText
      };
    }

    await this.start({ printQrToTerminal: false });

    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      if (this.state.status === "connected") {
        return {
          status: "connected",
          user: this.socket?.user ?? this.state.user,
          qrText: null
        };
      }

      if (this.state.currentQrText) {
        return {
          status: "awaiting_qr_scan",
          user: null,
          qrText: this.state.currentQrText
        };
      }

      await delay(250);
    }

    throw new Error(
      `Timed out waiting for WhatsApp auth to start. Current status: ${this.state.status}.`
    );
  }

  #renderQr(value) {
    return renderCompactQr(value);
  }
}
