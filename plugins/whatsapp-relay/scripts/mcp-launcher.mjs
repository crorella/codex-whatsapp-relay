import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
const serverEntry = path.join(
  codexHome,
  "plugins",
  "whatsapp-relay",
  "plugins",
  "whatsapp-relay",
  "scripts",
  "mcp-server.mjs"
);

try {
  await fs.access(serverEntry);
} catch {
  throw new Error(
    `Hardened WhatsApp relay checkout not found at ${serverEntry}. Reinstall it from the reviewed fork before enabling this plugin.`
  );
}

await import(pathToFileURL(serverEntry).href);
