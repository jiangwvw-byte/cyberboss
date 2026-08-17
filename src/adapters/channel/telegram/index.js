const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const { promisify } = require("util");
const execFileAsync = promisify(execFile);

const MAX_MESSAGE_CHARS = 4000;

function createTelegramChannelAdapter(config) {
  const token = readSecret(config.telegramTokenFile);
  if (!token) {
    throw new Error(`Missing Telegram bot token file: ${config.telegramTokenFile}`);
  }
  const botId = token.split(":", 1)[0];
  const accountId = `telegram-${botId}`;
  let offset = readOffset(config.telegramOffsetFile);
  const contextTokens = {};

  async function call(method, params = {}, timeoutMs = 20_000) {
    const args = [
      "-fsS",
      "--max-time", String(Math.max(2, Math.ceil(timeoutMs / 1000))),
      "-X", "POST",
      `https://api.telegram.org/bot${token}/${method}`,
    ];
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null || value === "") continue;
      const encoded = typeof value === "string" ? value : JSON.stringify(value);
      args.push("--data-urlencode", `${key}=${encoded}`);
    }
    const { stdout } = await execFileAsync("curl", args, {
      timeout: timeoutMs + 5_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    const payload = JSON.parse(stdout);
    if (!payload?.ok) {
      throw new Error(`Telegram ${method} failed: ${payload?.description || "unknown error"}`);
    }
    return payload.result;
  }

  async function callMultipart(method, fields, fileField, filePath, timeoutMs = 60_000) {
    const args = ["-fsS", "--max-time", String(Math.ceil(timeoutMs / 1000)), `https://api.telegram.org/bot${token}/${method}`];
    for (const [key, value] of Object.entries(fields || {})) {
      if (value !== undefined && value !== null && value !== "") args.push("-F", `${key}=${value}`);
    }
    args.push("-F", `${fileField}=@${filePath}`);
    const { stdout } = await execFileAsync("curl", args, { timeout: timeoutMs + 5_000, maxBuffer: 4 * 1024 * 1024 });
    const payload = JSON.parse(stdout);
    if (!payload?.ok) throw new Error(`Telegram ${method} failed: ${payload?.description || "unknown error"}`);
    return payload.result;
  }

  return {
    describe() {
      return { id: "telegram", kind: "channel", stateDir: config.stateDir, accountId };
    },
    async login() {},
    printAccounts() {
      console.log(`- ${accountId}`);
    },
    resolveAccount() {
      return { accountId, userId: botId, baseUrl: "https://api.telegram.org", savedAt: "" };
    },
    getKnownContextTokens() {
      return { ...contextTokens };
    },
    loadSyncBuffer() {
      return String(offset || 0);
    },
    saveSyncBuffer(value) {
      const parsed = Number.parseInt(String(value || "0"), 10);
      if (Number.isFinite(parsed) && parsed >= 0) {
        offset = parsed;
        writeAtomic(config.telegramOffsetFile, `${offset}\n`);
      }
    },
    rememberContextToken(userId, value) {
      if (userId && value) contextTokens[String(userId)] = String(value);
      return String(value || "");
    },
    async getUpdates({ timeoutMs = 35_000 } = {}) {
      const timeout = Math.max(1, Math.min(30, Math.floor(timeoutMs / 1000) - 1));
      const updates = await call("getUpdates", {
        offset,
        timeout,
        allowed_updates: ["message"],
      }, (timeout + 5) * 1000);
      if (updates.length) {
        const nextOffset = Math.max(...updates.map((item) => Number(item.update_id) || 0)) + 1;
        this.saveSyncBuffer(nextOffset);
      }
      return { ret: 0, msgs: updates, get_updates_buf: String(offset) };
    },
    normalizeIncomingMessage(update) {
      const message = update?.message;
      const senderId = String(message?.from?.id || "");
      const chatId = String(message?.chat?.id || "");
      const text = String(message?.text || message?.caption || "").trim();
      const attachments = extractTelegramAttachments(message);
      if (!senderId || !chatId || (!text && !attachments.length) || message?.chat?.type !== "private") return null;
      contextTokens[senderId] = chatId;
      return {
        provider: "telegram",
        accountId,
        workspaceId: config.workspaceId,
        senderId,
        chatId,
        messageId: String(message.message_id || update.update_id || ""),
        threadKey: chatId,
        text,
        attachments,
        contextToken: chatId,
        receivedAt: message.date ? new Date(message.date * 1000).toISOString() : new Date().toISOString(),
      };
    },
    async persistIncomingAttachments({ attachments, messageId = "", receivedAt = "" }) {
      const saved = [];
      const failed = [];
      for (const attachment of Array.isArray(attachments) ? attachments : []) {
        try {
          const file = await call("getFile", { file_id: attachment.fileId });
          if (!file?.file_path) throw new Error("Telegram getFile returned no file_path");
          const bytes = await downloadTelegramFile(token, file.file_path);
          const targetDir = path.join(config.stateDir, "inbox", normalizeDateFolder(receivedAt));
          const fileName = sanitizeFileName(attachment.fileName) || `telegram-${messageId || Date.now()}.bin`;
          const absolutePath = writeUniqueBuffer(targetDir, fileName, bytes);
          const transcript = attachment.kind === "audio" ? await transcribeTelegramAudio(absolutePath) : "";
          saved.push({
            kind: attachment.kind || "file",
            contentType: attachment.contentType || "application/octet-stream",
            isImage: attachment.kind === "image" || String(attachment.contentType || "").startsWith("image/"),
            sourceFileName: attachment.fileName || "",
            fileName: path.basename(absolutePath),
            absolutePath,
            relativePath: path.relative(config.stateDir, absolutePath).replace(/\\/g, "/"),
            sizeBytes: bytes.length,
            transcript,
          });
        } catch (error) {
          failed.push({ kind: attachment?.kind || "file", sourceFileName: attachment?.fileName || "", reason: error?.message || String(error) });
        }
      }
      return { saved, failed };
    },
    async sendText({ userId, text, contextToken = "" }) {
      const chatId = String(contextToken || contextTokens[String(userId)] || userId || "");
      for (const chunk of splitText(String(text || ""), MAX_MESSAGE_CHARS)) {
        await call("sendMessage", { chat_id: chatId, text: chunk });
      }
    },
    async sendTyping({ userId, status = 1, contextToken = "" }) {
      if (!status) return;
      const chatId = String(contextToken || contextTokens[String(userId)] || userId || "");
      if (chatId) await call("sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => null);
    },
    async sendFile({ userId, filePath, contextToken = "" }) {
      const chatId = String(contextToken || contextTokens[String(userId)] || userId || "");
      if (!chatId) throw new Error("Missing Telegram chat id for file delivery.");
      const absolutePath = path.resolve(String(filePath || ""));
      if (!fs.statSync(absolutePath).isFile()) throw new Error(`Telegram file not found: ${absolutePath}`);
      const upload = resolveTelegramUpload(absolutePath);
      return callMultipart(upload.method, { chat_id: chatId }, upload.field, absolutePath);
    },
    setMinChunkChars() { return 20; },
    getMinChunkChars() { return 20; },
  };
}

function readSecret(filePath) {
  try { return fs.readFileSync(filePath, "utf8").trim(); } catch { return ""; }
}
function readOffset(filePath) {
  try { return Math.max(0, Number.parseInt(fs.readFileSync(filePath, "utf8").trim(), 10) || 0); } catch { return 0; }
}
function writeAtomic(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temp, content, { mode: 0o600 });
  fs.renameSync(temp, filePath);
}
function splitText(text, maxChars) {
  const chars = Array.from(text.trim());
  if (!chars.length) return [];
  const chunks = [];
  while (chars.length) chunks.push(chars.splice(0, maxChars).join(""));
  return chunks;
}

function extractTelegramAttachments(message) {
  const attachments = [];
  const photos = Array.isArray(message?.photo) ? message.photo : [];
  const photo = photos[photos.length - 1];
  if (photo?.file_id) {
    attachments.push({
      kind: "image",
      fileId: String(photo.file_id),
      fileName: `telegram-photo-${message?.message_id || Date.now()}.jpg`,
      contentType: "image/jpeg",
      index: 0,
    });
  }
  const document = message?.document;
  if (document?.file_id) {
    const contentType = String(document.mime_type || "application/octet-stream");
    attachments.push({
      kind: contentType.startsWith("image/") ? "image" : "file",
      fileId: String(document.file_id),
      fileName: sanitizeFileName(document.file_name) || `telegram-document-${message?.message_id || Date.now()}${extensionFromContentType(contentType)}`,
      contentType,
      index: attachments.length,
    });
  }
  const voice = message?.voice || message?.audio;
  if (voice?.file_id) {
    const contentType = String(voice.mime_type || "audio/ogg");
    attachments.push({
      kind: "audio",
      fileId: String(voice.file_id),
      fileName: sanitizeFileName(voice.file_name) || `telegram-voice-${message?.message_id || Date.now()}${extensionFromContentType(contentType) || ".ogg"}`,
      contentType,
      index: attachments.length,
    });
  }
  const sticker = message?.sticker;
  if (sticker?.file_id) {
    const contentType = sticker.is_animated ? "application/x-tgsticker" : sticker.is_video ? "video/webm" : "image/webp";
    attachments.push({
      kind: contentType.startsWith("image/") ? "image" : "sticker",
      fileId: String(sticker.file_id),
      fileName: `telegram-sticker-${message?.message_id || Date.now()}${extensionFromContentType(contentType) || (sticker.is_animated ? ".tgs" : sticker.is_video ? ".webm" : ".webp")}`,
      contentType,
      index: attachments.length,
    });
  }
  return attachments;
}

async function downloadTelegramFile(token, filePath) {
  const { stdout } = await execFileAsync("curl", [
    "-fsS", "--max-time", "60", `https://api.telegram.org/file/bot${token}/${filePath}`,
  ], { encoding: "buffer", timeout: 65_000, maxBuffer: 25 * 1024 * 1024 });
  return Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout);
}

function sanitizeFileName(value) {
  return path.basename(String(value || "")).replace(/[\\/:*?"<>|\x00-\x1f]/g, "-").trim().slice(0, 120);
}
function extensionFromContentType(value) {
  return ({ "image/jpeg": ".jpg", "image/png": ".png", "image/gif": ".gif", "image/webp": ".webp", "application/pdf": ".pdf", "text/plain": ".txt" })[String(value || "").toLowerCase()] || "";
}
function normalizeDateFolder(receivedAt) {
  const date = receivedAt ? new Date(receivedAt) : new Date();
  return Number.isNaN(date.getTime()) ? new Date().toISOString().slice(0, 10) : date.toISOString().slice(0, 10);
}
function writeUniqueBuffer(targetDir, fileName, bytes) {
  fs.mkdirSync(targetDir, { recursive: true });
  const parsed = path.parse(fileName || "attachment.bin");
  for (let index = 0; index < 1000; index += 1) {
    const candidate = path.join(targetDir, `${parsed.name || "attachment"}${index ? `-${index + 1}` : ""}${parsed.ext}`);
    try {
      const fd = fs.openSync(candidate, "wx", 0o600);
      try { fs.writeFileSync(fd, bytes); } finally { fs.closeSync(fd); }
      return candidate;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
  }
  throw new Error("Unable to allocate Telegram attachment file name");
}
function isImageFile(filePath) {
  return [".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"].includes(path.extname(filePath).toLowerCase());
}
function resolveTelegramUpload(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".gif") return { method: "sendAnimation", field: "animation" };
  if ([".ogg", ".oga", ".opus"].includes(ext)) return { method: "sendVoice", field: "voice" };
  if ([".mp3", ".m4a", ".wav", ".flac"].includes(ext)) return { method: "sendAudio", field: "audio" };
  if ([".tgs", ".webm"].includes(ext)) return { method: "sendSticker", field: "sticker" };
  if (isImageFile(filePath)) return { method: "sendPhoto", field: "photo" };
  return { method: "sendDocument", field: "document" };
}
async function transcribeTelegramAudio(filePath) {
  const script = path.join(__dirname, "../../../../scripts/transcribe-telegram-audio.py");
  const python = "/home/ubuntu/.cyberboss-telegram/voice-venv/bin/python";
  const { stdout } = await execFileAsync(python, [script, filePath], { timeout: 5 * 60_000, maxBuffer: 1024 * 1024 });
  const result = JSON.parse(String(stdout || "{}"));
  return String(result.text || "").trim();
}

module.exports = { createTelegramChannelAdapter, extractTelegramAttachments };
