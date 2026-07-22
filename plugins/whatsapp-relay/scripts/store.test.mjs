import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { WhatsAppStore } from "./store.mjs";

test("store reads message bodies from memory without persisting them", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "whatsapp-safe-store-"));
  const storePath = path.join(tempDir, "store.json");
  try {
    const store = new WhatsAppStore(storePath);
    store.ingestMessage({
      key: { id: "m1", remoteJid: "group@g.us", fromMe: false },
      messageTimestamp: 123,
      pushName: "Private Sender",
      message: { conversation: "PRIVATE MESSAGE BODY" }
    });
    await store.save();

    assert.deepEqual(store.getMessages("group@g.us", 20), [
      {
        id: "m1",
        chatId: "group@g.us",
        participant: null,
        fromMe: false,
        pushName: "Private Sender",
        timestamp: 123,
        text: "PRIVATE MESSAGE BODY",
        messageType: "conversation"
      }
    ]);

    const raw = await fs.readFile(storePath, "utf8");
    const saved = JSON.parse(raw);
    const mode = (await fs.stat(storePath)).mode & 0o777;

    assert.equal(raw.includes("PRIVATE MESSAGE BODY"), false);
    assert.equal(saved.messages, undefined);
    assert.equal(saved.chats["group@g.us"].lastMessageText, undefined);
    assert.equal(mode, 0o600);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("volatile message buffers enforce per-chat, global, and text limits", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "whatsapp-safe-bounds-"));
  const storePath = path.join(tempDir, "store.json");
  try {
    const store = new WhatsAppStore(storePath, {
      maxMessagesPerChat: 2,
      maxMessagesTotal: 3,
      maxTextChars: 5
    });
    const ingest = (chatId, id, timestamp, text) =>
      store.ingestMessage({
        key: { id, remoteJid: chatId, fromMe: false },
        messageTimestamp: timestamp,
        message: { conversation: text }
      });

    ingest("a@g.us", "a1", 1, "123456789");
    ingest("a@g.us", "a2", 2, "second");
    ingest("a@g.us", "a3", 3, "third");
    ingest("b@g.us", "b1", 4, "fourth");
    ingest("b@g.us", "b2", 5, "fifth");

    assert.deepEqual(
      store.getMessages("a@g.us", 10).map((message) => [message.id, message.text]),
      [["a3", "third"]]
    );
    assert.deepEqual(
      store.getMessages("b@g.us", 10).map((message) => message.id),
      ["b1", "b2"]
    );
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("loading a legacy cache removes persisted message content", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "whatsapp-safe-legacy-"));
  const storePath = path.join(tempDir, "store.json");
  try {
    await fs.writeFile(
      storePath,
      JSON.stringify({
        chats: {
          "group@g.us": {
            id: "group@g.us",
            name: "Family",
            lastMessageText: "OLD SECRET",
            lastMessageType: "conversation"
          }
        },
        contacts: {},
        messages: {
          "group@g.us": [{ text: "OLD SECRET" }]
        }
      })
    );

    const store = new WhatsAppStore(storePath);
    await store.load();
    const raw = await fs.readFile(storePath, "utf8");

    assert.equal(raw.includes("OLD SECRET"), false);
    assert.equal(store.data.messages, undefined);
    assert.deepEqual(store.getMessages("group@g.us"), []);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
