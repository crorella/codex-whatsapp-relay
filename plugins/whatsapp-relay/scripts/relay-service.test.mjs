import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { RelayClient } from "./relay-client.mjs";
import { createRelayHandler, createRelayServer } from "./relay-service.mjs";
import { WhatsAppStore } from "./store.mjs";

function fakeRuntime(store) {
  return {
    store,
    summary: () => ({ status: "connected", hasCreds: true, recentChatCount: 1 }),
    ensureConnected: async () => {},
    refreshChats: async () => {},
    sendText: async () => ({ messageId: "sent-1" }),
    startAuthFlow: async () => ({ status: "connected", user: { id: "self" } })
  };
}

test("persistent relay keeps bounded messages across independent clients and private cache", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "whatsapp-relay-service-"));
  const socketPath = path.join(tempDir, "run", "relay.sock");
  const storePath = path.join(tempDir, "store.json");
  const store = new WhatsAppStore(storePath);
  store.upsertChat({ id: "contact@s.whatsapp.net", name: "Contact" });
  const runtime = fakeRuntime(store);
  const server = await createRelayServer({ runtime, socketPath });

  try {
    const firstClient = new RelayClient({ socketPath, timeoutMs: 2_000 });
    const before = await firstClient.request("read_messages", {
      chatId: "contact@s.whatsapp.net"
    });
    assert.deepEqual(before.messages, []);

    store.ingestMessage({
      key: { id: "reply-1", remoteJid: "contact@s.whatsapp.net", fromMe: false },
      messageTimestamp: 123,
      message: { conversation: "PRIVATE REPLY" }
    });

    const secondClient = new RelayClient({ socketPath, timeoutMs: 2_000 });
    const after = await secondClient.request("read_messages", {
      chatId: "contact@s.whatsapp.net"
    });
    assert.equal(after.messages[0].text, "PRIVATE REPLY");
    assert.equal((await fs.stat(path.dirname(socketPath))).mode & 0o777, 0o700);
    assert.equal((await fs.stat(socketPath)).mode & 0o777, 0o600);
    await assert.rejects(
      createRelayServer({ runtime, socketPath }),
      /already using this socket/
    );
    assert.equal((await firstClient.request("status")).status, "connected");

    await store.save();
    assert.equal((await fs.readFile(storePath, "utf8")).includes("PRIVATE REPLY"), false);
    const cachePath = path.join(tempDir, "messages.json");
    assert.equal((await fs.readFile(cachePath, "utf8")).includes("PRIVATE REPLY"), true);
    assert.equal((await fs.stat(cachePath)).mode & 0o777, 0o600);
    await assert.rejects(secondClient.request("not_allowed"), /Unknown WhatsApp relay method/);
  } finally {
    await store.save();
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("relay handler rejects ambiguous sends and invalid text", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "whatsapp-relay-handler-"));
  const store = new WhatsAppStore(path.join(tempDir, "store.json"));
  store.upsertChat({ id: "one@s.whatsapp.net", name: "Same" });
  store.upsertChat({ id: "two@s.whatsapp.net", name: "Same" });
  const handler = createRelayHandler(fakeRuntime(store));
  try {
    await assert.rejects(
      handler("send_message", { chatName: "Same", text: "hello" }),
      (error) => error.candidates?.length === 2
    );
    await assert.rejects(
      handler("send_message", { chatId: "one@s.whatsapp.net", text: "" }),
      /between 1 and 4000/
    );
  } finally {
    await store.save();
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("relay handler resolves an exact cached attachment without executing it", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "whatsapp-relay-attachment-"));
  const store = new WhatsAppStore(path.join(tempDir, "store.json"));
  store.upsertChat({ id: "group@g.us", name: "Group" });
  store.ingestMessage({
    key: { id: "media-1", remoteJid: "group@g.us", fromMe: false },
    messageTimestamp: 123,
    normalizedMessageType: "imageMessage",
    attachments: [
      { kind: "image", mimeType: "image/jpeg", status: "downloaded", path: "/private/image.jpg" }
    ],
    message: { conversation: "caption" }
  });
  const handler = createRelayHandler(fakeRuntime(store));
  try {
    const result = await handler("get_attachment", {
      chatId: "group@g.us",
      messageId: "media-1"
    });
    assert.equal(result.attachmentIndex, 0);
    assert.equal(result.kind, "image");
    assert.equal(result.path, "/private/image.jpg");
  } finally {
    await store.save();
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
