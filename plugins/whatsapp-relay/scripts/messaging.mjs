export async function sendTextMessage(socket, chatId, text) {
  if (!chatId?.trim()) {
    throw new Error("A WhatsApp chat id is required.");
  }
  if (!text?.trim()) {
    throw new Error("Message text is required.");
  }

  return socket.sendMessage(chatId, {
    text,
    linkPreview: null
  });
}
