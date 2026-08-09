const test = require("node:test");
const assert = require("node:assert/strict");

const { CyberbossApp } = require("../src/core/app");

test("incoming messages register tokens and wake the outbox", async () => {
  const calls = [];
  const normalized = {
    accountId: "account-1",
    senderId: "user-1",
    contextToken: "token-a",
    text: "hello",
  };
  const appLike = {
    config: { allowedUserIds: ["user-1"] },
    channelAdapter: {
      normalizeIncomingMessage() {
        return normalized;
      },
    },
    outboundTokenRegistry: {
      observe(payload) {
        calls.push(["observe", payload]);
      },
    },
    outboundDeliveryCoordinator: {
      async flushNext(accountId, userId) {
        calls.push(["flush", accountId, userId]);
      },
    },
    primeDeferredRepliesForSender() {
      calls.push(["prime"]);
    },
    async handlePreparedMessage(message) {
      calls.push(["handle", message]);
    },
  };

  await CyberbossApp.prototype.handleIncomingMessage.call(appLike, {});

  assert.deepEqual(calls, [
    ["observe", {
      accountId: "account-1",
      userId: "user-1",
      token: "token-a",
    }],
    ["flush", "account-1", "user-1"],
    ["prime"],
    ["handle", normalized],
  ]);
});

test("incoming messages without a token still reach normal handling", async () => {
  const calls = [];
  const normalized = {
    accountId: "account-1",
    senderId: "user-1",
    contextToken: "",
    text: "hello",
  };
  const appLike = {
    config: { allowedUserIds: ["user-1"] },
    channelAdapter: {
      normalizeIncomingMessage() {
        return normalized;
      },
    },
    outboundTokenRegistry: {
      observe() {
        calls.push("observe");
      },
    },
    outboundDeliveryCoordinator: {
      async flushNext() {
        calls.push("flush");
      },
    },
    primeDeferredRepliesForSender() {
      calls.push("prime");
    },
    async handlePreparedMessage() {
      calls.push("handle");
    },
  };

  await CyberbossApp.prototype.handleIncomingMessage.call(appLike, {});

  assert.deepEqual(calls, ["prime", "handle"]);
});


test("unauthorized incoming messages are ignored before token registration", async () => {
  const calls = [];
  const appLike = {
    config: { allowedUserIds: ["user-1"] },
    channelAdapter: {
      normalizeIncomingMessage() {
        return {
          accountId: "account-1",
          senderId: "intruder",
          contextToken: "intruder-token",
          text: "run something",
        };
      },
    },
    outboundTokenRegistry: {
      observe() {
        calls.push("observe");
      },
    },
    outboundDeliveryCoordinator: {
      async flushNext() {
        calls.push("flush");
      },
    },
    primeDeferredRepliesForSender() {
      calls.push("prime");
    },
    async handlePreparedMessage() {
      calls.push("handle");
    },
  };

  await CyberbossApp.prototype.handleIncomingMessage.call(appLike, {});
  assert.deepEqual(calls, []);
});
test("completed image artifacts enter the outbox for the exact turn", async () => {
  const enqueued = [];
  const flushed = [];
  const appLike = {
    activeAccountId: "account-1",
    streamDelivery: {
      async handleRuntimeEvent() {},
      resolveReplyTargetForRun() {
        return {
          userId: "user-1",
          contextToken: "token-a",
          provider: "weixin",
        };
      },
    },
    outboundMediaStore: {
      persist({ sourcePath }) {
        return sourcePath;
      },
    },
    outboundDeliveryStore: {
      enqueue(delivery) {
        enqueued.push(delivery);
        return delivery;
      },
    },
    outboundDeliveryCoordinator: {
      async flushNext(accountId, userId) {
        flushed.push([accountId, userId]);
      },
    },
  };

  await CyberbossApp.prototype.handleRuntimeEvent.call(appLike, {
    type: "runtime.artifact.completed",
    payload: {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "image-item-1",
      kind: "image",
      status: "completed",
      filePath: __filename,
      completedAtMs: 1785686400123,
    },
  });

  assert.equal(enqueued.length, 1);
  assert.equal(enqueued[0].userId, "user-1");
  assert.equal(enqueued[0].kind, "image");
  assert.equal(enqueued[0].filePath, __filename);
  assert.deepEqual(flushed, [["account-1", "user-1"]]);
});
