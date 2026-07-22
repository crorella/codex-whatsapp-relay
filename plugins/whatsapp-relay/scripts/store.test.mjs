import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { WhatsAppStore } from "./store.mjs";

test("store persists chat metadata without message bodies using mode 0600", async () => {
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
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
