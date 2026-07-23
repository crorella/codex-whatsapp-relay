import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ensureRuntimeDirs, relaySocketFile } from "./paths.mjs";
import { WhatsAppRuntime } from "./runtime.mjs";

const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_RECONNECT_DELAY_MS = 5 * 60_000;

function boundedInteger(value, fallback, minimum, maximum) {
  const candidate = value === undefined ? fallback : value;
  if (!Number.isInteger(candidate) || candidate < minimum || candidate > maximum) {
    throw new Error(`Expected an integer between ${minimum} and ${maximum}.`);
  }
  return candidate;
}

function requireOptionalString(value, label) {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value;
}

function resolveChatOrError(store, { chatId, chatName }) {
  const resolved = store.resolveChat({ chatId, chatName });
  if (resolved.match) return resolved.match;
  if (resolved.candidates.length > 1) {
    const error = new Error(`Multiple chats matched "${chatName}".`);
    error.candidates = resolved.candidates.slice(0, 10);
    throw error;
  }
  throw new Error(
    chatId
      ? `Chat "${chatId}" was not found in the local WhatsApp cache.`
      : `Chat "${chatName}" was not found in the local WhatsApp cache.`
  );
}

export function createRelayHandler(runtime) {
  return async (method, params = {}) => {
    if (!params || typeof params !== "object" || Array.isArray(params)) {
      throw new Error("Request parameters must be an object.");
    }

    if (method === "status") return runtime.summary();
    if (method === "start_auth") return runtime.startAuthFlow();

    if (method === "list_chats") {
      const limit = boundedInteger(params.limit, 20, 1, 100);
      const query = requireOptionalString(params.query, "query");
      const unreadOnly = params.unreadOnly === undefined ? false : params.unreadOnly;
      if (typeof unreadOnly !== "boolean") throw new Error("unreadOnly must be boolean.");
      if (runtime.summary().status === "connected") await runtime.refreshChats();
      return runtime.store.listChats({ limit, query, unreadOnly });
    }

    if (method === "read_messages") {
      const chatId = requireOptionalString(params.chatId, "chatId");
      const chatName = requireOptionalString(params.chatName, "chatName");
      const limit = boundedInteger(params.limit, 20, 1, 100);
      await runtime.ensureConnected();
      const chat = resolveChatOrError(runtime.store, { chatId, chatName });
      return {
        chat: { id: chat.id, displayName: chat.displayName },
        messages: runtime.store.getMessages(chat.id, limit)
      };
    }

    if (method === "send_message") {
      const chatId = requireOptionalString(params.chatId, "chatId");
      const chatName = requireOptionalString(params.chatName, "chatName");
      if (typeof params.text !== "string" || !params.text || params.text.length > 4_000) {
        throw new Error("text must contain between 1 and 4000 characters.");
      }
      const chat = resolveChatOrError(runtime.store, { chatId, chatName });
      const sent = await runtime.sendText(chat.id, params.text);
      return { chat: { id: chat.id, displayName: chat.displayName }, ...sent };
    }

    throw new Error("Unknown WhatsApp relay method.");
  };
}

async function removeStaleSocket(socketPath) {
  try {
    const stat = await fs.lstat(socketPath);
    if (!stat.isSocket() || stat.uid !== process.getuid()) {
      throw new Error("Refusing to replace a non-socket or foreign relay path.");
    }
    const active = await new Promise((resolve) => {
      const probe = net.createConnection({ path: socketPath });
      const finish = (value) => {
        probe.destroy();
        resolve(value);
      };
      probe.once("connect", () => finish(true));
      probe.once("error", () => finish(false));
      probe.setTimeout(500, () => finish(false));
    });
    if (active) throw new Error("A WhatsApp relay service is already using this socket.");
    await fs.unlink(socketPath);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

export async function createRelayServer({
  runtime,
  socketPath = relaySocketFile,
  handler = createRelayHandler(runtime)
}) {
  const socketDir = path.dirname(socketPath);
  await fs.mkdir(socketDir, { recursive: true, mode: 0o700 });
  await fs.chmod(socketDir, 0o700);
  await removeStaleSocket(socketPath);

  const server = net.createServer((socket) => {
    socket.setEncoding("utf8");
    let buffered = "";
    let receivedBytes = 0;
    let handled = false;

    const respond = (payload) => {
      if (!socket.destroyed) socket.end(`${JSON.stringify(payload)}\n`);
    };

    socket.on("data", (chunk) => {
      if (handled) return;
      receivedBytes += Buffer.byteLength(chunk);
      if (receivedBytes > MAX_REQUEST_BYTES) {
        handled = true;
        respond({ id: 0, ok: false, error: { message: "Request too large." } });
        return;
      }
      buffered += chunk;
      const newline = buffered.indexOf("\n");
      if (newline < 0) return;
      handled = true;
      let request;
      try {
        request = JSON.parse(buffered.slice(0, newline));
      } catch {
        respond({ id: 0, ok: false, error: { message: "Invalid request." } });
        return;
      }
      if (!Number.isInteger(request.id) || request.id <= 0 || typeof request.method !== "string") {
        respond({ id: request.id ?? 0, ok: false, error: { message: "Invalid request." } });
        return;
      }
      Promise.resolve(handler(request.method, request.params ?? {})).then(
        (result) => respond({ id: request.id, ok: true, result }),
        (error) =>
          respond({
            id: request.id,
            ok: false,
            error: {
              message: error?.message || "WhatsApp relay request failed.",
              candidates: error?.candidates
            }
          })
      );
    });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
  await fs.chmod(socketPath, 0o600);
  return server;
}

export function maintainSavedConnection(runtime) {
  let stopped = false;
  let timer = null;
  let attempts = 0;

  const clear = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };

  const schedule = () => {
    if (stopped || timer || !runtime.hasSavedCreds()) return;
    const delayMs = Math.min(5_000 * 2 ** attempts, MAX_RECONNECT_DELAY_MS);
    attempts += 1;
    timer = setTimeout(async () => {
      timer = null;
      try {
        await runtime.start();
        await runtime.waitForConnection(20_000);
        attempts = 0;
      } catch {
        schedule();
      }
    }, delayMs);
  };

  const unsubscribe = runtime.on("connection.update", (summary) => {
    if (summary.status === "connected") {
      attempts = 0;
      clear();
    } else if (
      summary.hasCreds &&
      summary.status === "disconnected"
    ) {
      schedule();
    }
  });

  return () => {
    stopped = true;
    clear();
    unsubscribe();
  };
}

async function main() {
  process.umask(0o077);
  const runtime = new WhatsAppRuntime();
  await runtime.initialize();
  const server = await createRelayServer({ runtime });
  const stopReconnect = maintainSavedConnection(runtime);

  if (runtime.hasSavedCreds()) {
    runtime.start().catch(() => {});
  }

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    stopReconnect();
    await new Promise((resolve) => server.close(resolve));
    await runtime.close().catch(() => {});
    await removeStaleSocket(relaySocketFile).catch(() => {});
  };

  process.once("SIGINT", () => stop().finally(() => process.exit(0)));
  process.once("SIGTERM", () => stop().finally(() => process.exit(0)));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch(() => process.exit(1));
}
