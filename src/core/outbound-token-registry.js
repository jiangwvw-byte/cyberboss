const fs = require("node:fs");
const path = require("node:path");

class OutboundTokenRegistry {
  constructor({ filePath }) {
    this.filePath = filePath;
    this.state = { recipients: {} };
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    this.load();
  }

  load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      this.state = {
        recipients: parsed?.recipients
          && typeof parsed.recipients === "object"
          ? parsed.recipients
          : {},
      };
    } catch {
      this.state = { recipients: {} };
    }
  }

  save() {
    const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(temporaryPath, JSON.stringify(this.state, null, 2), { mode: 0o600 });
    fs.renameSync(temporaryPath, this.filePath);
  }

  observe({ accountId = "", userId = "", token = "" } = {}) {
    this.load();
    const key = buildRecipientKey(accountId, userId);
    const normalizedToken = normalizeText(token);
    if (!key || !normalizedToken) {
      throw new Error("invalid outbound token observation");
    }

    const current = this.state.recipients[key] || null;
    if (current?.token === normalizedToken) {
      return { ...current };
    }

    const next = {
      accountId: normalizeText(accountId),
      userId: normalizeText(userId),
      token: normalizedToken,
      version: normalizeVersion(current?.version) + 1,
      invalid: false,
      updatedAt: new Date().toISOString(),
    };
    this.state.recipients[key] = next;
    this.save();
    return { ...next };
  }

  getCurrent(accountId, userId) {
    this.load();
    const key = buildRecipientKey(accountId, userId);
    const current = key ? this.state.recipients[key] : null;
    return current ? { ...current } : null;
  }

  invalidate({
    accountId = "",
    userId = "",
    tokenVersion = 0,
  } = {}) {
    this.load();
    const key = buildRecipientKey(accountId, userId);
    const current = key ? this.state.recipients[key] : null;
    if (!current) {
      return null;
    }

    if (current.version !== normalizeVersion(tokenVersion)) {
      return { ...current };
    }
    if (current.invalid) {
      return { ...current };
    }

    current.invalid = true;
    current.updatedAt = new Date().toISOString();
    this.save();
    return { ...current };
  }
}

function buildRecipientKey(accountId, userId) {
  const account = normalizeText(accountId);
  const user = normalizeText(userId);
  if (!account || !user) {
    return "";
  }
  return `${encodeURIComponent(account)}::${encodeURIComponent(user)}`;
}

function normalizeVersion(value) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : 0;
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = { OutboundTokenRegistry };
