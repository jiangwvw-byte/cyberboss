const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");

const { CodexRpcClient } = require("../src/adapters/runtime/codex/rpc-client");

test("codex rpc client uses turn/interrupt for stop requests", async () => {
  const client = new CodexRpcClient({ endpoint: "ws://127.0.0.1:8765" });
  const calls = [];
  client.sendRequest = async (method, params) => {
    calls.push({ method, params });
    return { ok: true };
  };

  await client.cancelTurn({
    threadId: "thread-1",
    turnId: "turn-1",
  });

  assert.deepEqual(calls, [{
    method: "turn/interrupt",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
    },
  }]);
});

test("codex rpc client sends image attachments as local images", async (t) => {
  const client = new CodexRpcClient({ endpoint: "ws://127.0.0.1:8765" });
  const calls = [];
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "cyberboss-rpc-image-"),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const imagePath = path.join(root, "cyberboss image.jpg");
  const imageBytes = Buffer.from("fake-image-data");
  fs.writeFileSync(imagePath, imageBytes);
  client.sendRequest = async (method, params) => {
    calls.push({ method, params });
    return { result: { turn: { id: "turn-1" } } };
  };

  await client.sendUserMessage({
    threadId: "thread-1",
    text: "what is this image?",
    attachments: [{
      absolutePath: imagePath,
      contentType: "image/jpeg",
    }],
  });

  assert.equal(calls[0].method, "turn/start");
  assert.deepEqual(calls[0].params.input, [
    { type: "text", text: "what is this image?" },
    {
      type: "image",
      url: `data:image/jpeg;base64,${imageBytes.toString("base64")}`,
    },
  ]);
});
