"use strict";

const fs = require("fs");

const DEFAULT_TIMEOUT_MS = 8000;

function clampCount(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 10;
  }
  const rounded = Math.floor(value);
  if (rounded < 1) return 1;
  if (rounded > 20) return 20;
  return rounded;
}

function sanitizeTimeoutMs(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_TIMEOUT_MS;
  }
  return Math.floor(value);
}

function normalizeAllowedHosts(input) {
  if (!Array.isArray(input)) {
    return [];
  }
  const hosts = input
    .map((host) => (typeof host === "string" ? host.trim().toLowerCase() : ""))
    .filter(Boolean);
  return Array.from(new Set(hosts));
}

function getEffectiveAllowedHosts(globalAllowedHosts, providerAllowedHosts) {
  if (Array.isArray(providerAllowedHosts)) {
    return normalizeAllowedHosts(providerAllowedHosts);
  }
  return normalizeAllowedHosts(globalAllowedHosts);
}

function validateCustomBaseUrl(baseUrl, globalAllowedHosts, providerAllowedHosts) {
  if (typeof baseUrl !== "string" || !baseUrl.trim()) {
    throw new Error("Custom provider requires baseUrl");
  }

  let parsed;
  try {
    parsed = new URL(baseUrl.trim());
  } catch {
    throw new Error("Custom provider baseUrl is invalid");
  }

  if (parsed.protocol !== "https:") {
    throw new Error("Custom provider baseUrl must use https");
  }

  const allowlist = getEffectiveAllowedHosts(globalAllowedHosts, providerAllowedHosts);
  if (allowlist.length > 0 && !allowlist.includes(parsed.hostname.toLowerCase())) {
    throw new Error("Custom provider host is not allowed");
  }

  return parsed.toString();
}

function getApiKey(apiKeyValue) {
  if (typeof apiKeyValue !== "string") {
    return "";
  }

  const rawValue = apiKeyValue.trim();
  if (!rawValue) {
    return "";
  }

  if (rawValue.startsWith("${") && rawValue.endsWith("}")) {
    const envVar = rawValue.slice(2, -1).trim();
    if (!envVar) {
      return "";
    }
    const envValue = process.env[envVar];
    return typeof envValue === "string" && envValue.trim() ? envValue.trim() : "";
  }

  if (fs.existsSync(rawValue)) {
    return fs.readFileSync(rawValue, "utf-8").trim();
  }

  return rawValue;
}

function resolveApiKey(provider) {
  if (provider && typeof provider.apiKeyEnv === "string" && provider.apiKeyEnv.trim()) {
    const envValue = process.env[provider.apiKeyEnv.trim()];
    if (typeof envValue === "string" && envValue.trim()) {
      return envValue.trim();
    }
  }
  return getApiKey(provider ? provider.apiKey : undefined);
}

function sanitizeErrorMessage(err) {
  const message = err instanceof Error ? err.message : String(err);
  if (!message) return "request failed";
  // Redact likely key/token material and file paths.
  return message
    .replace(/(api[_-]?key|token|secret)\s*[:=]\s*[^,\s)]+/gi, "$1=[redacted]")
    .replace(/(?:\/[^/\s]+)+/g, "[path]");
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  clampCount,
  sanitizeTimeoutMs,
  validateCustomBaseUrl,
  getEffectiveAllowedHosts,
  getApiKey,
  resolveApiKey,
  sanitizeErrorMessage,
};
