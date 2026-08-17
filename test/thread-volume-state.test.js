const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { SessionStore } = require("../src/adapters/runtime/codex/session-store");

test("thread volumes reset their clock for a replacement thread", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-volume-"));
  const store = new SessionStore({ filePath: path.join(dir, "sessions.json"), runtimeId: "codex" });
  store.setThreadIdForWorkspace("binding", "/workspace", "thread-one");
  assert.match(store.getThreadVolumeState("binding", "/workspace").startedAt, /^\d{4}-/);
  store.setThreadVolumeState("binding", "/workspace", {
    startedAt: "2026-08-01T00:00:00.000Z",
    reminderSentAt: "2026-08-06T00:00:00.000Z",
  });
  store.setThreadIdForWorkspace("binding", "/workspace", "thread-two");
  const next = store.getThreadVolumeState("binding", "/workspace");
  assert.notEqual(next.startedAt, "2026-08-01T00:00:00.000Z");
  assert.equal(next.reminderSentAt, "");
});

test("thread volume state survives reload", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-volume-reload-"));
  const filePath = path.join(dir, "sessions.json");
  const store = new SessionStore({ filePath, runtimeId: "codex" });
  store.setThreadIdForWorkspace("binding", "/workspace", "thread-one");
  store.setThreadVolumeState("binding", "/workspace", {
    startedAt: "2026-08-13T00:00:00.000Z",
    reminderSentAt: "",
  });
  const reloaded = new SessionStore({ filePath, runtimeId: "codex" });
  assert.deepEqual(reloaded.getThreadVolumeState("binding", "/workspace"), {
    startedAt: "2026-08-13T00:00:00.000Z",
    reminderSentAt: "",
  });
});
