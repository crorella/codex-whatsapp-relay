import fs from "node:fs/promises";
import path from "node:path";

function emptyStore() {
  return {
    meta: {
      updatedAt: null,
      lastConnection: null
    },
    chats: {},
    contacts: {}
  };
}

function normalizeTimestamp(value) {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "bigint") {
    return Number(value);
  }
  if (typeof value === "object" && typeof value.toNumber === "function") {
    return value.toNumber();
  }
  if (typeof value === "object" && typeof value.low === "number") {
    return value.low;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function preferredChatName(chat, contact) {
  return (
    chat.name ||
    chat.subject ||
    chat.pushName ||
    contact?.name ||
    contact?.notify ||
    contact?.verifiedName ||
    chat.id
  );
}

function sanitizeChat(chat = {}) {
  const {
    lastMessageText: _lastMessageText,
    lastMessageType: _lastMessageType,
    ...metadata
  } = chat;
  return metadata;
}

export class WhatsAppStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.data = emptyStore();
    this.pendingSave = null;
  }

  async load() {
    try {
      const parsed = JSON.parse(await fs.readFile(this.filePath, "utf8"));
      this.data = {
        meta: {
          ...emptyStore().meta,
          ...(parsed.meta ?? {})
        },
        chats: Object.fromEntries(
          Object.entries(parsed.chats ?? {}).map(([id, chat]) => [id, sanitizeChat(chat)])
        ),
        contacts: parsed.contacts ?? {}
      };
      await this.save();
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
    }
  }

  async save() {
    this.data.meta.updatedAt = new Date().toISOString();
    const tempFile = path.join(
      path.dirname(this.filePath),
      `.${path.basename(this.filePath)}.${process.pid}.${Date.now()}.tmp`
    );
    await fs.writeFile(tempFile, JSON.stringify(this.data, null, 2), {
      encoding: "utf8",
      mode: 0o600
    });
    await fs.rename(tempFile, this.filePath);
    await fs.chmod(this.filePath, 0o600);
  }

  scheduleSave() {
    if (this.pendingSave) {
      clearTimeout(this.pendingSave);
    }
    this.pendingSave = setTimeout(() => {
      this.pendingSave = null;
      this.save().catch((error) => {
        console.error("failed to save WhatsApp chat metadata", error);
      });
    }, 300);
  }

  updateMeta(partial) {
    this.data.meta = { ...this.data.meta, ...partial };
    this.scheduleSave();
  }

  upsertContact(contact) {
    if (!contact?.id) {
      return;
    }
    const existing = this.data.contacts[contact.id] ?? {};
    this.data.contacts[contact.id] = {
      ...existing,
      id: contact.id,
      name: contact.name ?? existing.name ?? null,
      notify: contact.notify ?? existing.notify ?? null,
      verifiedName: contact.verifiedName ?? existing.verifiedName ?? null,
      updatedAt: new Date().toISOString()
    };
    this.scheduleSave();
  }

  upsertChat(chat) {
    if (!chat?.id) {
      return;
    }
    const existing = this.data.chats[chat.id] ?? {};
    const contact = this.data.contacts[chat.id];
    const normalized = {
      ...existing,
      id: chat.id,
      name:
        chat.name ??
        chat.subject ??
        existing.name ??
        contact?.name ??
        contact?.notify ??
        null,
      archived: chat.archived ?? existing.archived ?? false,
      unreadCount: chat.unreadCount ?? existing.unreadCount ?? 0,
      timestamp:
        normalizeTimestamp(
          chat.conversationTimestamp ??
            chat.lastMessageRecvTimestamp ??
            chat.lastMsgTimestamp ??
            chat.timestamp
        ) ?? existing.timestamp ?? null,
      isGroup: chat.id.endsWith("@g.us"),
      updatedAt: new Date().toISOString()
    };
    normalized.displayName = preferredChatName(normalized, contact);
    this.data.chats[chat.id] = normalized;
    this.scheduleSave();
  }

  ingestHistory(history = {}) {
    for (const contact of history.contacts ?? []) {
      this.upsertContact(contact);
    }
    for (const chat of history.chats ?? []) {
      this.upsertChat(chat);
    }
    for (const message of history.messages ?? []) {
      this.ingestMessage(message, { incrementUnread: false });
    }
  }

  ingestMessage(message, { incrementUnread = true } = {}) {
    const remoteJid = message?.key?.remoteJid;
    if (!remoteJid) {
      return;
    }
    const timestamp = normalizeTimestamp(message.messageTimestamp);
    const currentChat = this.data.chats[remoteJid] ?? {
      id: remoteJid,
      isGroup: remoteJid.endsWith("@g.us")
    };
    const contact = this.data.contacts[remoteJid];
    this.data.chats[remoteJid] = {
      ...currentChat,
      displayName: preferredChatName(currentChat, contact),
      name:
        currentChat.name ??
        message.pushName ??
        contact?.name ??
        contact?.notify ??
        null,
      lastMessageTimestamp: Math.max(
        currentChat.lastMessageTimestamp ?? currentChat.timestamp ?? 0,
        timestamp ?? 0
      ),
      unreadCount:
        incrementUnread && !message.key?.fromMe
          ? (currentChat.unreadCount ?? 0) + 1
          : currentChat.unreadCount ?? 0,
      updatedAt: new Date().toISOString()
    };
    this.scheduleSave();
  }

  listChats({ limit = 20, query, unreadOnly = false } = {}) {
    const normalizedQuery = query?.trim().toLowerCase();
    return Object.values(this.data.chats)
      .map((chat) => ({
        ...chat,
        displayName: preferredChatName(chat, this.data.contacts[chat.id])
      }))
      .filter((chat) => {
        if (unreadOnly && !(chat.unreadCount > 0)) {
          return false;
        }
        if (!normalizedQuery) {
          return true;
        }
        return [
          chat.id,
          chat.displayName,
          chat.name,
          this.data.contacts[chat.id]?.name,
          this.data.contacts[chat.id]?.notify
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase()
          .includes(normalizedQuery);
      })
      .sort(
        (a, b) =>
          (b.lastMessageTimestamp ?? b.timestamp ?? 0) -
          (a.lastMessageTimestamp ?? a.timestamp ?? 0)
      )
      .slice(0, limit);
  }

  resolveChat({ chatId, chatName }) {
    if (chatId) {
      const match = this.data.chats[chatId] ?? null;
      return { match, candidates: match ? [match] : [] };
    }

    const query = chatName?.trim().toLowerCase();
    if (!query) {
      throw new Error("Provide chatId or chatName.");
    }

    const candidates = this.listChats({ limit: 100 }).filter((chat) =>
      [chat.displayName, chat.name]
        .filter(Boolean)
        .some((name) => name.toLowerCase().includes(query))
    );
    const exact = candidates.filter((chat) =>
      [chat.displayName, chat.name]
        .filter(Boolean)
        .some((name) => name.toLowerCase() === query)
    );

    return {
      match: exact.length === 1 ? exact[0] : candidates.length === 1 ? candidates[0] : null,
      candidates: exact.length > 1 ? exact : candidates
    };
  }
}
