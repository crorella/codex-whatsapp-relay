import test from "node:test";
import assert from "node:assert/strict";

import { sendTextMessage } from "./messaging.mjs";

test("sendTextMessage disables URL previews", async () => {
  const calls = [];
  const socket = {
    async sendMessage(chatId, content) {
      calls.push({ chatId, content });
      return { key: { id: "sent" } };
    }
  };

  await sendTextMessage(socket, "group@g.us", "See http://127.0.0.1/private");

  assert.deepEqual(calls, [
    {
      chatId: "group@g.us",
      content: {
        text: "See http://127.0.0.1/private",
        linkPreview: null
      }
    }
  ]);
});
