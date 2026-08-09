const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  OutboundDeliveryStore,
} = require("../src/core/outbound-delivery-store");
const {
  OutboundTokenRegistry,
} = require("../src/core/outbound-token-registry");
const {
  OutboundDeliveryCoordinator,
} = require("../src/core/outbound-delivery-coordinator");

test("coordinator sends an image with the registered token", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-delivery-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new OutboundDeliveryStore({
    filePath: path.join(root, "outbox.json"),
  });
  const tokenRegistry = new OutboundTokenRegistry({
    filePath: path.join(root, "tokens.json"),
  });
  const sent = [];
  const coordinator = new OutboundDeliveryCoordinator({
    store,
    tokenRegistry,
    channelAdapter: {
      async sendFile(payload) {
        sent.push(payload);
      },
    },
  });

  tokenRegistry.observe({
    accountId: "account-1",
    userId: "user-1",
    token: "token-a",
  });
  store.enqueue({
    deliveryId: "image-1",
    accountId: "account-1",
    userId: "user-1",
    kind: "image",
    priority: 300,
    status: "pending",
    filePath: "/tmp/generated.png",
  });

  const result = await coordinator.flushNext("account-1", "user-1");

  assert.equal(result.status, "sent");
  assert.deepEqual(sent, [{
    userId: "user-1",
    filePath: "/tmp/generated.png",
    contextToken: "token-a",
  }]);
  assert.equal(
    store.listForRecipient("account-1", "user-1")[0].status,
    "sent",
  );
});

test("coordinator defers on ret=-2 and retries with a new token", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-delivery-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new OutboundDeliveryStore({
    filePath: path.join(root, "outbox.json"),
  });
  const tokenRegistry = new OutboundTokenRegistry({
    filePath: path.join(root, "tokens.json"),
  });
  let attempts = 0;
  const coordinator = new OutboundDeliveryCoordinator({
    store,
    tokenRegistry,
    channelAdapter: {
      async sendFile() {
        attempts += 1;
        if (attempts === 1) {
          const error = new Error("sendMessage ret=-2");
          error.ret = -2;
          throw error;
        }
      },
    },
  });

  tokenRegistry.observe({
    accountId: "account-1",
    userId: "user-1",
    token: "token-a",
  });
  store.enqueue({
    deliveryId: "image-retry-1",
    accountId: "account-1",
    userId: "user-1",
    kind: "image",
    priority: 300,
    status: "pending",
    filePath: "/tmp/generated.png",
  });

  const deferred = await coordinator.flushNext("account-1", "user-1");
  assert.equal(deferred.status, "deferred");
  assert.equal(tokenRegistry.getCurrent("account-1", "user-1").invalid, true);
  assert.equal(
    store.listForRecipient("account-1", "user-1")[0].status,
    "deferred",
  );

  const waiting = await coordinator.flushNext("account-1", "user-1");
  assert.equal(waiting.status, "waiting_for_token");
  assert.equal(attempts, 1);

  tokenRegistry.observe({
    accountId: "account-1",
    userId: "user-1",
    token: "token-b",
  });
  const sent = await coordinator.flushNext("account-1", "user-1");
  assert.equal(sent.status, "sent");
  assert.equal(attempts, 2);
});

test("coordinator marks non-token send errors as failed", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-delivery-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new OutboundDeliveryStore({
    filePath: path.join(root, "outbox.json"),
  });
  const tokenRegistry = new OutboundTokenRegistry({
    filePath: path.join(root, "tokens.json"),
  });
  const coordinator = new OutboundDeliveryCoordinator({
    store,
    tokenRegistry,
    channelAdapter: {
      async sendFile() {
        throw new Error("network failure");
      },
    },
  });

  tokenRegistry.observe({
    accountId: "account-1",
    userId: "user-1",
    token: "token-a",
  });
  store.enqueue({
    deliveryId: "image-failed-1",
    accountId: "account-1",
    userId: "user-1",
    kind: "image",
    priority: 300,
    status: "pending",
    filePath: "/tmp/generated.png",
  });

  const result = await coordinator.flushNext("account-1", "user-1");

  assert.equal(result.status, "failed");
  assert.equal(
    store.listForRecipient("account-1", "user-1")[0].status,
    "failed",
  );
});
