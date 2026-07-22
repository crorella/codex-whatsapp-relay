import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { sendTextMessage } from "./messaging.mjs";
import { credsFile, storeFile } from "./paths.mjs";
import { WhatsAppRuntime } from "./runtime.mjs";

const runtime = new WhatsAppRuntime({
  logLevel: process.env.WHATSAPP_LOG_LEVEL ?? "warn"
});

await runtime.initialize();

function textResult(text, { isError = false } = {}) {
  return {
    content: [{ type: "text", text }],
    isError
  };
}

function formatQrBlock(qrText) {
  return ["```text", qrText.trimEnd(), "```"].join("\n");
}

function chatSummary(chat) {
  const stamp = chat.lastMessageTimestamp ?? chat.timestamp;
  return [
    `- ${chat.displayName} (${chat.id})`,
    `group=${chat.isGroup ? "yes" : "no"}`,
    `unread=${chat.unreadCount ?? 0}`,
    stamp ? `last=${new Date(stamp * 1000).toISOString()}` : null
  ]
    .filter(Boolean)
    .join(" ");
}

function resolveChatOrError({ chatId, chatName }) {
  const resolved = runtime.store.resolveChat({ chatId, chatName });
  if (resolved.match) {
    return resolved.match;
  }
  if (resolved.candidates.length > 1) {
    throw new Error(
      `Multiple chats matched "${chatName}". Candidates:\n${resolved.candidates
        .slice(0, 10)
        .map(chatSummary)
        .join("\n")}`
    );
  }
  throw new Error(
    chatId
      ? `Chat "${chatId}" was not found in the local WhatsApp cache.`
      : `Chat "${chatName}" was not found in the local WhatsApp cache.`
  );
}

const server = new McpServer({
  name: "whatsapp-relay-hardened",
  version: "0.4.3-hardened.4"
});

server.tool(
  "whatsapp_start_auth",
  "Start local WhatsApp linked-device authentication and return a QR code.",
  {},
  async () => {
    try {
      const result = await runtime.startAuthFlow();
      if (result.status === "connected") {
        return textResult(`WhatsApp is already connected as ${result.user?.id ?? "unknown"}.`);
      }
      return textResult(
        [
          "Scan this QR code from WhatsApp.",
          "",
          formatQrBlock(result.qrText),
          "",
          "WhatsApp -> Settings -> Linked Devices -> Link a Device",
          "After scanning, call `whatsapp_auth_status`."
        ].join("\n")
      );
    } catch (error) {
      return textResult(error.message, { isError: true });
    }
  }
);

server.tool(
  "whatsapp_auth_status",
  "Show whether the local WhatsApp linked-device session is connected.",
  {},
  async () => {
    const summary = runtime.summary();
    const lines = [
      `status: ${summary.status}`,
      `credentials: ${summary.hasCreds ? "present" : "missing"}`,
      `auth_file: ${credsFile}`,
      `chat_metadata_file: ${storeFile}`,
      `recent_chat_count: ${summary.recentChatCount}`
    ];
    if (summary.user?.id) {
      lines.push(`user: ${summary.user.id}`);
    }
    if (summary.currentQrText) {
      lines.push("qr_ready: yes", "", "current_qr:", formatQrBlock(summary.currentQrText));
    }
    if (summary.lastDisconnect?.label) {
      lines.push(`last_disconnect: ${summary.lastDisconnect.label}`);
    }
    if (!summary.hasCreds) {
      lines.push("next_step: call `whatsapp_start_auth`");
    }
    return textResult(lines.join("\n"));
  }
);

server.tool(
  "whatsapp_list_chats",
  "List WhatsApp chat metadata from the local cache. Message bodies are not retained.",
  {
    limit: z.number().int().min(1).max(100).optional(),
    query: z.string().min(1).optional(),
    unreadOnly: z.boolean().optional()
  },
  async ({ limit = 20, query, unreadOnly = false }) => {
    try {
      const chats = runtime.store.listChats({ limit, query, unreadOnly });
      return textResult(
        chats.length ? chats.map(chatSummary).join("\n") : "No chats matched the requested filter."
      );
    } catch (error) {
      return textResult(error.message, { isError: true });
    }
  }
);

server.tool(
  "whatsapp_send_message",
  "Send one text message to a WhatsApp chat by exact id or unambiguous cached name. URL previews are disabled.",
  {
    chatId: z.string().min(1).optional(),
    chatName: z.string().min(1).optional(),
    text: z.string().min(1).max(4000)
  },
  async ({ chatId, chatName, text }) => {
    try {
      const chat = resolveChatOrError({ chatId, chatName });
      const socket = await runtime.ensureConnected();
      await sendTextMessage(socket, chat.id, text);
      return textResult(`Sent message to ${chat.displayName} (${chat.id}).`);
    } catch (error) {
      return textResult(error.message, { isError: true });
    }
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
