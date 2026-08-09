const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  OutboundMediaStore,
} = require("../src/core/outbound-media-store");

test("outbound media is copied to durable private storage", (t) => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "cyberboss-outbound-media-"),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const sourcePath = path.join(root, "generated-image.png");
  const directory = path.join(root, "outbound-media");
  fs.writeFileSync(sourcePath, Buffer.from("fake-image-data"));

  const store = new OutboundMediaStore({ directory });
  const firstPath = store.persist({
    sourcePath,
    deliveryId: "codex-image:thread-1:turn-1:item-1",
  });
  const secondPath = store.persist({
    sourcePath,
    deliveryId: "codex-image:thread-1:turn-1:item-1",
  });

  assert.equal(firstPath, secondPath);
  assert.equal(path.dirname(firstPath), directory);
  assert.equal(fs.readFileSync(firstPath, "utf8"), "fake-image-data");
  assert.equal(fs.statSync(firstPath).mode & 0o777, 0o600);
});
