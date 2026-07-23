import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { dataDir, pluginRoot } from "./paths.mjs";

const runFile = promisify(execFile);
const unitDir = path.join(os.homedir(), ".config", "systemd", "user");
const unitFile = path.join(unitDir, "codex-whatsapp-relay.service");
const serviceEntry = path.join(pluginRoot, "scripts", "relay-service.mjs");

function quoteUnit(value) {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

const unit = `[Unit]
Description=Persistent hardened WhatsApp relay for Codex
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${quoteUnit(process.execPath)} ${quoteUnit(serviceEntry)}
WorkingDirectory=${quoteUnit(pluginRoot)}
Restart=on-failure
RestartSec=5
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
PrivateDevices=true
ProtectSystem=full
ProtectHome=read-only
ReadWritePaths=${quoteUnit(dataDir)}
ProtectControlGroups=true
ProtectKernelModules=true
ProtectKernelTunables=true
RestrictSUIDSGID=true

[Install]
WantedBy=default.target
`;

await fs.mkdir(unitDir, { recursive: true, mode: 0o700 });
await fs.writeFile(unitFile, unit, { mode: 0o600 });
await fs.chmod(unitFile, 0o600);
await runFile("systemctl", ["--user", "daemon-reload"]);
await runFile("systemctl", ["--user", "enable", "--now", "codex-whatsapp-relay.service"]);
process.stdout.write(`installed: ${unitFile}\n`);
