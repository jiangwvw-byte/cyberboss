const fs = require("fs");
const path = require("path");

const DEFAULT_MIN_WEIXIN_CHUNK = 20;
const MAX_MIN_WEIXIN_CHUNK = 3800;

function loadWeixinConfig(config) {
  const filePath = config?.weixinConfigFile;
  const envDefault = normalizeMinChunkChars(
    config?.weixinMinChunkChars,
    DEFAULT_MIN_WEIXIN_CHUNK,
  );
  if (!filePath) {
    return { minChunkChars: envDefault, mediaProxyUrl: "" };
  }
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);
    return {
      minChunkChars: normalizeMinChunkChars(parsed?.minChunkChars, envDefault),
      mediaProxyUrl: normalizeText(parsed?.mediaProxyUrl),
    };
  } catch {
    return { minChunkChars: envDefault, mediaProxyUrl: "" };
  }
}

function saveWeixinConfig(config, values) {
  const filePath = config?.weixinConfigFile;
  if (!filePath) {
    return;
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(
    filePath,
    JSON.stringify(
      {
        minChunkChars: normalizeMinChunkChars(values?.minChunkChars),
        mediaProxyUrl: normalizeText(values?.mediaProxyUrl),
      },
      null,
      2,
    ),
  );
}

function normalizeMinChunkChars(value, defaultValue = DEFAULT_MIN_WEIXIN_CHUNK) {
  const parsed = Number.parseInt(String(value), 10);
  if (Number.isFinite(parsed) && parsed >= 1 && parsed <= MAX_MIN_WEIXIN_CHUNK) {
    return parsed;
  }
  return defaultValue;
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = {
  loadWeixinConfig,
  saveWeixinConfig,
  DEFAULT_MIN_WEIXIN_CHUNK,
  MAX_MIN_WEIXIN_CHUNK,
  normalizeMinChunkChars,
};
