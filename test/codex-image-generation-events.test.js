const test = require("node:test");
const assert = require("node:assert/strict");

const {
  mapCodexMessageToRuntimeEvent,
} = require("../src/adapters/runtime/codex/events");

test("codex image generation completions map to runtime artifact events", () => {
  const event = mapCodexMessageToRuntimeEvent({
    method: "item/completed",
    params: {
      completedAtMs: 1785686400123,
      threadId: "thread-image-1",
      turnId: "turn-image-1",
      item: {
        id: "item-image-1",
        type: "imageGeneration",
        status: "completed",
        result: "image generation completed",
        revisedPrompt: "A revised prompt",
        savedPath: "/tmp/generated-image.png",
      },
    },
  });

  assert.deepEqual(event, {
    type: "runtime.artifact.completed",
    payload: {
      threadId: "thread-image-1",
      turnId: "turn-image-1",
      itemId: "item-image-1",
      kind: "image",
      status: "completed",
      filePath: "/tmp/generated-image.png",
      completedAtMs: 1785686400123,
    },
  });
});
