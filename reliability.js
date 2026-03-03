"use strict";

const fs = require("fs");
const path = require("path");

const DEFAULT_PROVIDER_COOLDOWN_MS = 30000;

function sanitizeCooldownMs(value, fallback = DEFAULT_PROVIDER_COOLDOWN_MS) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.floor(value);
}

function normalizeUsageData(rawData, currentMonth) {
  if (!rawData || typeof rawData !== "object" || Array.isArray(rawData)) {
    return {};
  }

  const output = {};
  for (const [providerId, info] of Object.entries(rawData)) {
    if (!providerId || !info || typeof info !== "object" || Array.isArray(info)) {
      continue;
    }
    const month = typeof info.month === "string" && info.month ? info.month : currentMonth;
    const count = Number.isFinite(info.count) ? Math.max(0, Math.floor(info.count)) : 0;
    output[providerId] = month === currentMonth ? { count, month } : { count: 0, month: currentMonth };
  }
  return output;
}

function readUsageFile(filePath, currentMonth, fsImpl = fs) {
  if (!fsImpl.existsSync(filePath)) {
    return {};
  }
  try {
    const parsed = JSON.parse(fsImpl.readFileSync(filePath, "utf-8"));
    return normalizeUsageData(parsed, currentMonth);
  } catch {
    return {};
  }
}

function writeUsageFileAtomic(filePath, data, fsImpl = fs) {
  const dir = path.dirname(filePath);
  if (!fsImpl.existsSync(dir)) {
    fsImpl.mkdirSync(dir, { recursive: true });
  }

  const tempFile = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const content = JSON.stringify(data, null, 2);
  fsImpl.writeFileSync(tempFile, content);
  try {
    fsImpl.renameSync(tempFile, filePath);
  } finally {
    if (fsImpl.existsSync(tempFile)) {
      fsImpl.unlinkSync(tempFile);
    }
  }
}

function isRetryableProviderError(err) {
  const message = err instanceof Error ? err.message : String(err || "");
  if (!message) return false;
  if (/timed out/i.test(message)) return true;
  const statusMatch = message.match(/\b(\d{3})\b/);
  if (!statusMatch) return false;
  const status = Number(statusMatch[1]);
  return status === 429 || status >= 500;
}

function markProviderUnhealthy(state, providerId, cooldownMs, nowMs = Date.now()) {
  state[providerId] = nowMs + sanitizeCooldownMs(cooldownMs);
  return state[providerId];
}

function isProviderHealthy(state, providerId, nowMs = Date.now()) {
  return (state[providerId] || 0) <= nowMs;
}

module.exports = {
  DEFAULT_PROVIDER_COOLDOWN_MS,
  sanitizeCooldownMs,
  readUsageFile,
  writeUsageFileAtomic,
  isRetryableProviderError,
  markProviderUnhealthy,
  isProviderHealthy,
};
