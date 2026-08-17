const test = require("node:test");
const assert = require("node:assert/strict");

const { extractTelegramAttachments } = require("../src/adapters/channel/telegram");

test("extracts the highest-resolution Telegram photo", () => {
  const attachments = extractTelegramAttachments({
    message_id: 42,
    photo: [
      { file_id: "small", width: 90, height: 90 },
      { file_id: "large", width: 1280, height: 720 },
    ],
  });

  assert.deepEqual(attachments, [{
    kind: "image",
    fileId: "large",
    fileName: "telegram-photo-42.jpg",
    contentType: "image/jpeg",
    index: 0,
  }]);
});

test("extracts document, voice, and sticker metadata", () => {
  const attachments = extractTelegramAttachments({
    message_id: 7,
    document: {
      file_id: "document-id",
      file_name: "../notes?.txt",
      mime_type: "text/plain",
    },
    voice: {
      file_id: "voice-id",
      mime_type: "audio/ogg",
    },
    sticker: {
      file_id: "sticker-id",
    },
  });

  assert.deepEqual(attachments.map(({ kind, fileId, fileName, contentType }) => ({
    kind, fileId, fileName, contentType,
  })), [
    {
      kind: "file",
      fileId: "document-id",
      fileName: "notes-.txt",
      contentType: "text/plain",
    },
    {
      kind: "audio",
      fileId: "voice-id",
      fileName: "telegram-voice-7.ogg",
      contentType: "audio/ogg",
    },
    {
      kind: "image",
      fileId: "sticker-id",
      fileName: "telegram-sticker-7.webp",
      contentType: "image/webp",
    },
  ]);
});
