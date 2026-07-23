import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const serverScript = path.join(scriptDir, "mcp-server.mjs");

test("MCP registers only the hardened messaging surface", () => {
  const source = fs.readFileSync(serverScript, "utf8");
  const names = [...source.matchAll(/server\.tool\(\s*\n?\s*"([^"]+)"/g)]
    .map((match) => match[1])
    .sort();

  assert.deepEqual(names, [
    "whatsapp_auth_status",
    "whatsapp_list_chats",
    "whatsapp_read_messages",
    "whatsapp_send_message",
    "whatsapp_start_auth"
  ]);
  assert.match(source, /new RelayClient\(\)/);
  assert.doesNotMatch(source, /new WhatsAppRuntime\(/);
});
