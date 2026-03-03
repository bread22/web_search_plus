"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  clampCount,
  resolveApiKey,
  validateCustomBaseUrl,
} = require("../security");
const {
  readUsageFile,
  writeUsageFileAtomic,
  DEFAULT_PROVIDER_COOLDOWN_MS,
  sanitizeCooldownMs,
  markProviderUnhealthy,
  isProviderHealthy,
} = require("../reliability");

function test(name, fn) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (err) {
    console.error(`FAIL ${name}`);
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}

test("apiKeyEnv takes precedence over apiKey", () => {
  process.env.TEST_KEY_ENV = "env-key";
  const provider = {
    apiKeyEnv: "TEST_KEY_ENV",
    apiKey: "literal-key",
  };
  assert.equal(resolveApiKey(provider), "env-key");
  delete process.env.TEST_KEY_ENV;
});

test("invalid apiKeyEnv value falls back to apiKey", () => {
  process.env.TEST_KEY_ENV = "   ";
  const provider = {
    apiKeyEnv: "TEST_KEY_ENV",
    apiKey: "fallback-key",
  };
  assert.equal(resolveApiKey(provider), "fallback-key");
  delete process.env.TEST_KEY_ENV;
});

test("invalid apiKey values resolve to empty", () => {
  assert.equal(resolveApiKey({ apiKey: "   " }), "");
  assert.equal(resolveApiKey({ apiKey: "${MISSING_TEST_ENV}" }), "");
});

test("apiKey file path is resolved and trimmed", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wsp-key-"));
  const keyPath = path.join(dir, "key.txt");
  fs.writeFileSync(keyPath, "  file-key  \n");
  assert.equal(resolveApiKey({ apiKey: keyPath }), "file-key");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("count is clamped to [1,20]", () => {
  assert.equal(clampCount(undefined), 10);
  assert.equal(clampCount(NaN), 10);
  assert.equal(clampCount(0), 1);
  assert.equal(clampCount(-5), 1);
  assert.equal(clampCount(1), 1);
  assert.equal(clampCount(7.9), 7);
  assert.equal(clampCount(20), 20);
  assert.equal(clampCount(50), 20);
});

test("custom URL requires https", () => {
  assert.throws(() => validateCustomBaseUrl("http://example.com/search"), /https/);
});

test("custom URL allowed when no allowlist exists", () => {
  const url = validateCustomBaseUrl("https://example.com/search");
  assert.equal(url, "https://example.com/search");
});

test("custom URL must match global allowlist when provided", () => {
  const url = validateCustomBaseUrl(
    "https://api.example.com/search",
    ["api.example.com", "other.example.com"],
  );
  assert.equal(url, "https://api.example.com/search");
  assert.throws(
    () => validateCustomBaseUrl("https://blocked.example.com/search", ["api.example.com"]),
    /not allowed/,
  );
});

test("provider allowlist overrides global allowlist", () => {
  const url = validateCustomBaseUrl(
    "https://provider-only.example.com/search",
    ["global.example.com"],
    ["provider-only.example.com"],
  );
  assert.equal(url, "https://provider-only.example.com/search");
});

test("corrupt usage file is handled gracefully", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wsp-usage-"));
  const usagePath = path.join(dir, "usage.json");
  fs.writeFileSync(usagePath, '{"broken": ');
  const loaded = readUsageFile(usagePath, "2026-03");
  assert.deepEqual(loaded, {});
  fs.rmSync(dir, { recursive: true, force: true });
});

test("atomic usage write keeps old file when rename fails", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wsp-usage-"));
  const usagePath = path.join(dir, "usage.json");
  fs.writeFileSync(usagePath, JSON.stringify({ brave: { count: 1, month: "2026-03" } }));

  const fsMock = {
    ...fs,
    renameSync() {
      throw new Error("rename failed");
    },
  };

  assert.throws(
    () => writeUsageFileAtomic(usagePath, { brave: { count: 2, month: "2026-03" } }, fsMock),
    /rename failed/,
  );
  const current = JSON.parse(fs.readFileSync(usagePath, "utf-8"));
  assert.equal(current.brave.count, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("provider cooldown skips and recovers after window", () => {
  const health = {};
  const now = 1_000;
  const cooldown = sanitizeCooldownMs(undefined, DEFAULT_PROVIDER_COOLDOWN_MS);
  const unhealthyUntil = markProviderUnhealthy(health, "brave", cooldown, now);
  assert.equal(unhealthyUntil, now + DEFAULT_PROVIDER_COOLDOWN_MS);
  assert.equal(isProviderHealthy(health, "brave", now + DEFAULT_PROVIDER_COOLDOWN_MS - 1), false);
  assert.equal(isProviderHealthy(health, "brave", now + DEFAULT_PROVIDER_COOLDOWN_MS), true);
});

process.on("exit", () => {
  if (process.exitCode && process.exitCode !== 0) {
    console.error("TESTS FAILED");
    return;
  }
  console.log("ALL TESTS PASSED");
});
