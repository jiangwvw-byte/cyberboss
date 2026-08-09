const fs = require("node:fs");
const path = require("node:path");

const VALID_KINDS = new Set(["text", "image", "file", "reminder"]);
const VALID_STATUSES = new Set([
  "pending",
  "sending",
  "sent",
  "deferred",
  "failed",
]);

class OutboundDeliveryStore {
  constructor({ filePath }) {
    this.filePath = filePath;
    this.state = { deliveries: [] };
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    this.load();
    this.recoverInterruptedDeliveries();
  }

  load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      const deliveries = Array.isArray(parsed?.deliveries)
        ? parsed.deliveries
        : [];
      this.state = {
        deliveries: deliveries
          .map(normalizeDelivery)
          .filter(Boolean)
          .sort(compareDeliveries),
      };
    } catch {
      this.state = { deliveries: [] };
    }
  }

  recoverInterruptedDeliveries() {
    let changed = false;
    for (const delivery of this.state.deliveries) {
      if (delivery.status !== "sending") {
        continue;
      }
      delivery.status = "failed";
      delivery.lastError = "delivery_outcome_unknown_after_restart";
      changed = true;
    }
    if (changed) {
      this.save();
    }
  }

  save() {
    const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(temporaryPath, JSON.stringify(this.state, null, 2), { mode: 0o600 });
    fs.renameSync(temporaryPath, this.filePath);
  }

  enqueue(input) {
    this.load();
    const delivery = normalizeDelivery(input);
    if (!delivery) {
      throw new Error("invalid outbound delivery");
    }

    const existing = this.state.deliveries.find(
      (item) => item.deliveryId === delivery.deliveryId,
    );
    if (existing) {
      return { ...existing };
    }

    this.state.deliveries.push(delivery);
    this.state.deliveries.sort(compareDeliveries);
    this.save();
    return { ...delivery };
  }

  listForRecipient(accountId, userId) {
    this.load();
    const normalizedAccountId = normalizeText(accountId);
    const normalizedUserId = normalizeText(userId);
    return this.state.deliveries
      .filter((item) => (
        item.accountId === normalizedAccountId
        && item.userId === normalizedUserId
      ))
      .map((item) => ({ ...item }));
  }

  claimNext(accountId, userId, { tokenVersion = 0 } = {}) {
    this.load();
    const normalizedAccountId = normalizeText(accountId);
    const normalizedUserId = normalizeText(userId);
    const normalizedTokenVersion = normalizeInteger(tokenVersion);
    const delivery = this.state.deliveries.find((item) => (
      item.accountId === normalizedAccountId
      && item.userId === normalizedUserId
      && (
        item.status === "pending"
        || (
          item.status === "deferred"
          && normalizedTokenVersion > item.tokenVersion
        )
      )
    ));

    if (!delivery) {
      return null;
    }

    delivery.status = "sending";
    delivery.tokenVersion = normalizedTokenVersion;
    delivery.attempts += 1;
    delivery.lastError = "";
    this.save();
    return { ...delivery };
  }

  markDeferred(deliveryId, { lastError = "" } = {}) {
    return this.updateDelivery(deliveryId, {
      status: "deferred",
      lastError: normalizeText(lastError),
    });
  }

  markFailed(deliveryId, { lastError = "" } = {}) {
    return this.updateDelivery(deliveryId, {
      status: "failed",
      lastError: normalizeText(lastError),
    });
  }

  markSent(deliveryId, { sentAt = "" } = {}) {
    return this.updateDelivery(deliveryId, {
      status: "sent",
      lastError: "",
      sentAt: normalizeIsoTime(sentAt) || new Date().toISOString(),
    });
  }

  updateDelivery(deliveryId, changes) {
    this.load();
    const normalizedDeliveryId = normalizeText(deliveryId);
    const delivery = this.state.deliveries.find(
      (item) => item.deliveryId === normalizedDeliveryId,
    );
    if (!delivery) {
      throw new Error(`unknown outbound delivery: ${normalizedDeliveryId}`);
    }

    Object.assign(delivery, changes);
    this.save();
    return { ...delivery };
  }
}

function normalizeDelivery(input) {
  if (!input || typeof input !== "object") {
    return null;
  }

  const deliveryId = normalizeText(input.deliveryId);
  const accountId = normalizeText(input.accountId);
  const userId = normalizeText(input.userId);
  const kind = normalizeText(input.kind).toLowerCase();
  const status = normalizeText(input.status || "pending").toLowerCase();
  const filePath = normalizeText(input.filePath);
  const text = normalizeText(input.text);

  if (
    !deliveryId
    || !accountId
    || !userId
    || !VALID_KINDS.has(kind)
    || !VALID_STATUSES.has(status)
  ) {
    return null;
  }

  if ((kind === "image" || kind === "file") && !filePath) {
    return null;
  }
  if ((kind === "text" || kind === "reminder") && !text) {
    return null;
  }

  return {
    deliveryId,
    accountId,
    userId,
    kind,
    priority: normalizeInteger(input.priority),
    status,
    tokenVersion: normalizeInteger(input.tokenVersion),
    attempts: normalizeInteger(input.attempts),
    lastError: normalizeText(input.lastError),
    text,
    filePath,
    createdAt: normalizeIsoTime(input.createdAt) || new Date().toISOString(),
    sentAt: normalizeIsoTime(input.sentAt) || null,
  };
}

function normalizeInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : 0;
}

function normalizeIsoTime(value) {
  const text = normalizeText(value);
  const milliseconds = Date.parse(text);
  return Number.isFinite(milliseconds)
    ? new Date(milliseconds).toISOString()
    : "";
}

function compareDeliveries(left, right) {
  if (left.priority !== right.priority) {
    return right.priority - left.priority;
  }
  return left.createdAt.localeCompare(right.createdAt)
    || left.deliveryId.localeCompare(right.deliveryId);
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = { OutboundDeliveryStore };
