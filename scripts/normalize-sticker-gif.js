#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const SIPS_PATH = "/usr/bin/sips";
const FFMPEG_PATH = "/usr/bin/ffmpeg";
const DEFAULT_SIZE = 480;

function main() {
  const args = process.argv.slice(2);
  const inputPath = readFlag(args, "--input");
  const outputPath = readFlag(args, "--output");
  const size = Number.parseInt(readFlag(args, "--size") || String(DEFAULT_SIZE), 10);

  if (!inputPath || !outputPath) {
    throw new Error("Usage: normalize-sticker-gif.js --input <path> --output <path> [--size 240]");
  }
  const resolvedInputPath = path.resolve(inputPath);
  const resolvedOutputPath = path.resolve(outputPath);
  if (!fs.existsSync(resolvedInputPath)) {
    throw new Error(`Input file does not exist: ${resolvedInputPath}`);
  }
  fs.mkdirSync(path.dirname(resolvedOutputPath), { recursive: true });

  const inputExt = path.extname(resolvedInputPath).toLowerCase();
  if (inputExt === ".gif") {
    fs.copyFileSync(resolvedInputPath, resolvedOutputPath);
    return;
  }

  const normalizedSize = Number.isInteger(size) && size > 0 ? size : DEFAULT_SIZE;
  let result;
  let toolName;

  if (process.platform === "darwin" && fs.existsSync(SIPS_PATH)) {
    toolName = "sips";
    result = spawnSync(SIPS_PATH, [
      "-s", "format", "gif",
      "-z", String(normalizedSize), String(normalizedSize),
      resolvedInputPath,
      "--out", resolvedOutputPath,
    ], { encoding: "utf8" });
  } else {
    if (!fs.existsSync(FFMPEG_PATH)) {
      throw new Error(`Required tool missing: ${FFMPEG_PATH}`);
    }
    toolName = "ffmpeg";
    result = spawnSync(FFMPEG_PATH, [
      "-y",
      "-i", resolvedInputPath,
      "-vf", `scale=${normalizedSize}:${normalizedSize}:force_original_aspect_ratio=decrease,pad=${normalizedSize}:${normalizedSize}:(ow-iw)/2:(oh-ih)/2:color=white`,
      resolvedOutputPath,
    ], { encoding: "utf8" });
  }

  if (result.status !== 0) {
    const stderr = String(result.stderr || "").trim();
    const stdout = String(result.stdout || "").trim();
    throw new Error(`${toolName} gif normalization failed: ${stderr || stdout || `exit ${result.status}`}`);
  }
  if (!fs.existsSync(resolvedOutputPath)) {
    throw new Error(`GIF normalization produced no output: ${resolvedOutputPath}`);
  }
}

function readFlag(args, flag) {
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === flag) {
      return String(args[index + 1] || "").trim();
    }
  }
  return "";
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error || "unknown error");
  console.error(message);
  process.exit(1);
}
