import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { hardenAuthState } from "./paths.mjs";

test("hardenAuthState applies 0700 directories and 0600 files", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "whatsapp-safe-auth-"));
  const nestedDir = path.join(tempDir, "nested");
  const creds = path.join(nestedDir, "creds.json");
  try {
    await fs.mkdir(nestedDir, { mode: 0o777 });
    await fs.writeFile(creds, "secret", { mode: 0o666 });
    await hardenAuthState(tempDir);

    assert.equal((await fs.stat(tempDir)).mode & 0o777, 0o700);
    assert.equal((await fs.stat(nestedDir)).mode & 0o777, 0o700);
    assert.equal((await fs.stat(creds)).mode & 0o777, 0o600);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
