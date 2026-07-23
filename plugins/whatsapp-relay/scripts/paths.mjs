import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
export const pluginRoot = path.resolve(scriptDir, "..");
export const repoRoot = path.resolve(pluginRoot, "..", "..");
export const dataDir = path.join(pluginRoot, "data");
export const authDir = path.join(dataDir, "auth");
export const runDir = path.join(dataDir, "run");
export const mediaDir = process.env.WHATSAPP_MEDIA_DIR || path.join(dataDir, "media");
export const storeFile = path.join(dataDir, "store.json");
export const messagesFile = path.join(dataDir, "messages.json");
export const runtimeFile = path.join(dataDir, "runtime.json");
export const relaySocketFile =
  process.env.WHATSAPP_RELAY_SOCKET || path.join(runDir, "relay.sock");
export const sessionDbFile =
  process.env.WHATSAPP_SESSION_DB || path.join(authDir, "whatsmeow.db");
export const credsFile = sessionDbFile;
export const sidecarBinary = path.join(pluginRoot, "bin", "whatsmeow-sidecar");

async function ensurePrivateDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true, mode: 0o700 });
  await fs.chmod(dirPath, 0o700);
}

export async function ensureRuntimeDirs() {
  await ensurePrivateDir(dataDir);
  await ensurePrivateDir(authDir);
  await ensurePrivateDir(runDir);
  await ensurePrivateDir(mediaDir);
}

export async function hardenAuthState(root = authDir) {
  await ensurePrivateDir(root);
  const entries = await fs.readdir(root, { withFileTypes: true });

  await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(root, entry.name);
      if (entry.isDirectory()) {
        await hardenAuthState(entryPath);
        return;
      }

      if (entry.isFile()) {
        await fs.chmod(entryPath, 0o600);
      }
    })
  );
}
