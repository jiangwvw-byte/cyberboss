const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  OutboundDeliveryStore,
} = require("../src/core/outbound-delivery-store");

test("outbox persists deliveries and deduplicates stable delivery ids", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-outbox-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const filePath = path.join(root, "outbound-deliveries.json");
  const delivery = {
    deliveryId: "delivery-image-1",
    accountId: "account-1",
    userId: "user-1",
    kind: "image",
    priority: 300,
    status: "pending",
    filePath: "/tmp/generated-image.png",
    createdAt: "2026-08-02T12:00:00.000Z",
  };

  const firstStore = new OutboundDeliveryStore({ filePath });
  firstStore.enqueue(delivery);
  firstStore.enqueue(delivery);

  const restoredStore = new OutboundDeliveryStore({ filePath });
  const restored = restoredStore.listForRecipient("account-1", "user-1");

  assert.equal(restored.length, 1);
  assert.equal(restored[0].deliveryId, "delivery-image-1");
  assert.equal(restored[0].status, "pending");
  assert.equal(restored[0].attempts, 0);
  assert.equal(restored[0].filePath, "/tmp/generated-image.png");
  assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);
});

test("outbox retries deferred deliveries only with a newer token", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-outbox-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const filePath = path.join(root, "outbound-deliveries.json");
  const store = new OutboundDeliveryStore({ filePath });

  store.enqueue({
    deliveryId: "delivery-image-retry",
    accountId: "account-1",
    userId: "user-1",
    kind: "image",
    priority: 300,
    status: "pending",
    filePath: "/tmp/retry-image.png",
    createdAt: "2026-08-02T12:00:00.000Z",
  });

  const firstAttempt = store.claimNext(
    "account-1",
    "user-1",
    { tokenVersion: 1 },
  );
  assert.equal(firstAttempt.status, "sending");
  assert.equal(firstAttempt.attempts, 1);
  assert.equal(firstAttempt.tokenVersion, 1);

  store.markDeferred("delivery-image-retry", {
    lastError: "ret=-2",
  });
  assert.equal(
    store.claimNext("account-1", "user-1", { tokenVersion: 1 }),
    null,
  );

  const secondAttempt = store.claimNext(
    "account-1",
    "user-1",
    { tokenVersion: 2 },
  );
  assert.equal(secondAttempt.attempts, 2);
  assert.equal(secondAttempt.tokenVersion, 2);

  store.markSent("delivery-image-retry", {
    sentAt: "2026-08-02T12:01:00.000Z",
  });

  const restored = new OutboundDeliveryStore({ filePath })
    .listForRecipient("account-1", "user-1");
  assert.equal(restored[0].status, "sent");
  assert.equal(restored[0].sentAt, "2026-08-02T12:01:00.000Z");
});

test("outbox does not blindly retry sending deliveries after restart", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-outbox-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const filePath = path.join(root, "outbound-deliveries.json");
  const store = new OutboundDeliveryStore({ filePath });

  store.enqueue({
    deliveryId: "delivery-unknown-1",
    accountId: "account-1",
    userId: "user-1",
    kind: "image",
    priority: 300,
    status: "pending",
    filePath: "/tmp/unknown-image.png",
  });
  store.claimNext("account-1", "user-1", { tokenVersion: 1 });

  const restored = new OutboundDeliveryStore({ filePath })
    .listForRecipient("account-1", "user-1");

  assert.equal(restored[0].status, "failed");
  assert.equal(
    restored[0].lastError,
    "delivery_outcome_unknown_after_restart",
  );
});
