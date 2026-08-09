const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  OutboundTokenRegistry,
} = require("../src/core/outbound-token-registry");

test("token registry versions new tokens and preserves invalidation", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-tokens-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const filePath = path.join(root, "outbound-token-registry.json");
  const registry = new OutboundTokenRegistry({ filePath });

  const first = registry.observe({
    accountId: "account-1",
    userId: "user-1",
    token: "token-a",
  });
  assert.equal(first.version, 1);
  assert.equal(first.invalid, false);

  const same = registry.observe({
    accountId: "account-1",
    userId: "user-1",
    token: "token-a",
  });
  assert.equal(same.version, 1);

  registry.invalidate({
    accountId: "account-1",
    userId: "user-1",
    tokenVersion: 1,
  });
  const repeatedInvalid = registry.observe({
    accountId: "account-1",
    userId: "user-1",
    token: "token-a",
  });
  assert.equal(repeatedInvalid.invalid, true);

  const next = registry.observe({
    accountId: "account-1",
    userId: "user-1",
    token: "token-b",
  });
  assert.equal(next.version, 2);
  assert.equal(next.invalid, false);

  const restored = new OutboundTokenRegistry({ filePath })
    .getCurrent("account-1", "user-1");
  assert.equal(restored.token, "token-b");
  assert.equal(restored.version, 2);
  assert.equal(restored.invalid, false);
  assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);
});
