const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

class OutboundMediaStore {
  constructor({ directory }) {
    this.directory = normalizeText(directory);
    if (!this.directory || !path.isAbsolute(this.directory)) {
      throw new Error("absolute outbound media directory is required");
    }
    fs.mkdirSync(this.directory, {
      recursive: true,
      mode: 0o700,
    });
    fs.chmodSync(this.directory, 0o700);
  }

  persist({ sourcePath = "", deliveryId = "" } = {}) {
    const normalizedSourcePath = normalizeText(sourcePath);
    const normalizedDeliveryId = normalizeText(deliveryId);
    if (
      !normalizedSourcePath
      || !path.isAbsolute(normalizedSourcePath)
      || !normalizedDeliveryId
    ) {
      throw new Error("invalid outbound media");
    }

    const sourceStat = fs.statSync(normalizedSourcePath);
    if (!sourceStat.isFile()) {
      throw new Error("outbound media source is not a file");
    }

    const digest = crypto
      .createHash("sha256")
      .update(normalizedDeliveryId)
      .digest("hex");
    const extension = normalizeExtension(
      path.extname(normalizedSourcePath),
    );
    const destinationPath = path.join(
      this.directory,
      `${digest}${extension}`,
    );

    if (fs.existsSync(destinationPath)) {
      return destinationPath;
    }

    const temporaryPath = path.join(
      this.directory,
      `.${digest}.${process.pid}.tmp`,
    );
    try {
      fs.copyFileSync(normalizedSourcePath, temporaryPath);
      fs.chmodSync(temporaryPath, 0o600);
      fs.renameSync(temporaryPath, destinationPath);
    } catch (error) {
      try {
        fs.unlinkSync(temporaryPath);
      } catch {
        // best effort
      }
      throw error;
    }

    return destinationPath;
  }
}

function normalizeExtension(value) {
  const extension = normalizeText(value).toLowerCase();
  return /^\.[a-z0-9]{1,10}$/.test(extension)
    ? extension
    : ".bin";
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = { OutboundMediaStore };
