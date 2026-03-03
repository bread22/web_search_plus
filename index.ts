const os = require("os");
const path = require("path");
const { resolveApiKey, sanitizeErrorMessage } = require("./security.js");
const { readUsageFile, writeUsageFileAtomic } = require("./reliability.js");

const USAGE_FILE = path.join(os.homedir(), ".openclaw/data/web_search_plus_usage.json");
const MAX_QUERY_LENGTH = 500;
const MAX_COUNT = 20;
const MIN_COUNT = 1;
const ALLOWED_PROVIDER_TYPES = new Set(["brave", "tavily", "custom"]);

interface ProviderConfig {
  id: string;
  type: string;
  apiKey: string;
  monthlyLimit: number;
  baseUrl?: string;
}

interface SearchFunction {
  (apiKey: string, query: string, count: number, extras?: Record<string, unknown>): Promise<unknown>;
}

interface ProviderRegistry {
  [key: string]: SearchFunction;
}

const providerRegistry: ProviderRegistry = {
  brave: async (apiKey: string, query: string, count: number, extras?: Record<string, unknown>): Promise<unknown> => {
    const params = new URLSearchParams({ q: query, count: String(count) });
    if (extras?.freshness) params.append("freshness", String(extras.freshness));
    
    const response = await fetch(`https://api.search.brave.com/res/v1/web/search?${params}`, {
      headers: {
        Accept: "application/json",
        "X-Subscription-Token": apiKey,
      },
      redirect: "error",
      signal: AbortSignal.timeout(10000),
    });
    
    if (!response.ok) {
      throw new Error(`Brave API error: ${response.status}`);
    }
    
    const data = await response.json();
    return {
      results: (data.web?.results || []).map((r: Record<string, unknown>) => ({
        title: r.title,
        url: r.url,
        description: r.description,
      })),
    };
  },
  
  tavily: async (apiKey: string, query: string, count: number): Promise<unknown> => {
    const response = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, max_results: count, api_key: apiKey }),
      redirect: "error",
      signal: AbortSignal.timeout(10000),
    });
    
    if (!response.ok) {
      throw new Error(`Tavily API error: ${response.status}`);
    }
    
    const data = await response.json();
    return {
      results: (data.results || []).map((r: Record<string, unknown>) => ({
        title: r.title,
        url: r.url,
        description: r.content,
      })),
    };
  },
  
  custom: async (apiKey: string, query: string, count: number, extras?: Record<string, unknown>): Promise<unknown> => {
    const baseUrl = extras?.baseUrl as string | undefined;
    if (!baseUrl) {
      throw new Error("Custom provider requires baseUrl");
    }
    
    const response = await fetch(baseUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, max_results: count, api_key: apiKey }),
      redirect: "error",
      signal: AbortSignal.timeout(10000),
    });
    
    if (!response.ok) {
      throw new Error(`Custom provider error: ${response.status}`);
    }
    
    return response.json();
  },
};

let usageData: Record<string, { count: number; month: string }> = {};

function getCurrentMonth(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

function loadUsage(): void {
  try {
    usageData = readUsageFile(USAGE_FILE, getCurrentMonth());
  } catch {
    usageData = {};
  }
}

function saveUsage(): void {
  try {
    writeUsageFileAtomic(USAGE_FILE, usageData);
  } catch {
    // ignore
  }
}

function getUsage(providerId: string): number {
  const currentMonth = getCurrentMonth();
  if (!usageData[providerId]) {
    usageData[providerId] = { count: 0, month: currentMonth };
  }
  if (usageData[providerId].month !== currentMonth) {
    usageData[providerId] = { count: 0, month: currentMonth };
  }
  return usageData[providerId].count;
}

function incrementUsage(providerId: string): void {
  const currentMonth = getCurrentMonth();
  if (!usageData[providerId]) {
    usageData[providerId] = { count: 0, month: currentMonth };
  }
  if (usageData[providerId].month !== currentMonth) {
    usageData[providerId] = { count: 0, month: currentMonth };
  }
  usageData[providerId].count++;
  saveUsage();
}

function isPrivateOrLoopbackIp(hostname: string): boolean {
  if (hostname === "::1") return true;
  if (hostname.startsWith("fe80:")) return true;
  if (hostname.startsWith("fc") || hostname.startsWith("fd")) return true;
  if (hostname === "0.0.0.0") return true;
  const ipv4Match = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!ipv4Match) return false;

  const octets = ipv4Match.slice(1).map((x) => Number(x));
  if (octets.some((x) => Number.isNaN(x) || x < 0 || x > 255)) return true;
  const [a, b] = octets;

  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

function isDisallowedHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  if (normalized === "localhost") return true;
  if (normalized.endsWith(".localhost")) return true;
  if (normalized === "127.0.0.1") return true;
  if (normalized === "::1") return true;
  return isPrivateOrLoopbackIp(normalized);
}

function validateCustomBaseUrl(
  provider: ProviderConfig,
  allowlist: string[],
): { ok: true; normalizedBaseUrl: string } | { ok: false; reason: string } {
  if (provider.type !== "custom") {
    return { ok: true, normalizedBaseUrl: provider.baseUrl || "" };
  }

  if (!provider.baseUrl || typeof provider.baseUrl !== "string") {
    return { ok: false, reason: "missing baseUrl" };
  }

  let parsed: URL;
  try {
    parsed = new URL(provider.baseUrl);
  } catch {
    return { ok: false, reason: "invalid baseUrl URL" };
  }

  if (parsed.protocol !== "https:") {
    return { ok: false, reason: "baseUrl must use https" };
  }
  if (isDisallowedHost(parsed.hostname)) {
    return { ok: false, reason: "baseUrl host is localhost/loopback/private" };
  }

  const allowed = allowlist.map((x) => x.trim().toLowerCase()).filter(Boolean);
  if (allowed.length === 0) {
    return { ok: false, reason: "customProviderAllowlist is empty" };
  }

  const host = parsed.host.toLowerCase();
  const origin = parsed.origin.toLowerCase();
  if (!allowed.includes(host) && !allowed.includes(origin)) {
    return { ok: false, reason: `baseUrl not in customProviderAllowlist: ${host}` };
  }

  return { ok: true, normalizedBaseUrl: parsed.toString() };
}

function sanitizeQuery(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_QUERY_LENGTH);
}

function validateAndNormalizeProviders(
  rawProviders: unknown,
  customProviderAllowlist: string[],
  logger?: { warn: (msg: string) => void },
): ProviderConfig[] {
  if (!Array.isArray(rawProviders)) {
    logger?.warn("[web_search_plus] Invalid config: providers must be an array");
    return [];
  }
  if (rawProviders.length < 1 || rawProviders.length > 20) {
    logger?.warn("[web_search_plus] Invalid config: providers length must be in range 1..20");
    return [];
  }

  const seenIds = new Set<string>();
  const normalizedProviders: ProviderConfig[] = [];

  for (const provider of rawProviders) {
    if (typeof provider !== "object" || provider === null) {
      logger?.warn("[web_search_plus] Skipping provider: entry must be an object");
      continue;
    }

    const candidate = provider as Partial<ProviderConfig>;
    const id = typeof candidate.id === "string" ? candidate.id.trim() : "";
    const type = typeof candidate.type === "string" ? candidate.type.trim() : "";
    const apiKey = typeof candidate.apiKey === "string" ? candidate.apiKey : "";
    const monthlyLimit = typeof candidate.monthlyLimit === "number" ? candidate.monthlyLimit : NaN;
    const baseUrl = typeof candidate.baseUrl === "string" ? candidate.baseUrl.trim() : undefined;

    if (!id || !type || !apiKey || !Number.isFinite(monthlyLimit) || monthlyLimit < 1) {
      logger?.warn(`[web_search_plus] Skipping provider: invalid required fields (id=${id || "<empty>"})`);
      continue;
    }
    if (!ALLOWED_PROVIDER_TYPES.has(type)) {
      logger?.warn(`[web_search_plus] Skipping provider ${id}: unsupported type (${type})`);
      continue;
    }
    if (seenIds.has(id)) {
      logger?.warn(`[web_search_plus] Skipping provider: duplicate id (${id})`);
      continue;
    }

    const normalizedProvider: ProviderConfig = { id, type, apiKey, monthlyLimit, baseUrl };
    const customValidation = validateCustomBaseUrl(normalizedProvider, customProviderAllowlist);
    if (!customValidation.ok) {
      logger?.warn(`[web_search_plus] Skipping provider ${id}: ${customValidation.reason}`);
      continue;
    }

    if (type === "custom") {
      normalizedProvider.baseUrl = customValidation.normalizedBaseUrl;
    } else {
      delete normalizedProvider.baseUrl;
    }

    normalizedProviders.push(normalizedProvider);
    seenIds.add(id);
  }

  return normalizedProviders;
}

function normalizeCount(rawCount: unknown): number {
  const value = typeof rawCount === "number" ? rawCount : Number(rawCount);
  if (!Number.isFinite(value)) return 10;
  const integer = Math.floor(value);
  if (integer < MIN_COUNT) return MIN_COUNT;
  if (integer > MAX_COUNT) return MAX_COUNT;
  return integer;
}

export default function (api: {
  config: Record<string, unknown>;
  pluginConfig?: Record<string, unknown>;
  registerTool: (tool: unknown) => void;
  logger?: { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void };
}) {
  loadUsage();

  const config = api.pluginConfig as {
    providers?: unknown;
    primaryProviderId?: string;
    customProviderAllowlist?: unknown;
  } | undefined;

  const customProviderAllowlist = Array.isArray(config?.customProviderAllowlist)
    ? config?.customProviderAllowlist.filter((x): x is string => typeof x === "string")
    : [];

  const providers = validateAndNormalizeProviders(config?.providers, customProviderAllowlist, api.logger);
  if (providers.length === 0) {
    api.logger?.warn("[web_search_plus] No valid providers configured, web_search will always fail");
  }

  const primaryProviderId = config?.primaryProviderId || providers[0]?.id;

  const sortedProviders = [...providers].sort((a, b) => {
    if (a.id === primaryProviderId) return -1;
    if (b.id === primaryProviderId) return 1;
    return 0;
  });

  api.registerTool({
    name: "web_search",
    description: "Search the web using configured search providers with automatic fallback",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
        count: { type: "number", description: "Number of results (range 1..20, default 10)" },
        freshness: { type: "string", enum: ["day", "week", "month"], description: "Filter by freshness (Brave only)" },
      },
      required: ["query"],
    },
    async execute(_toolCallId: string, params: Record<string, unknown>) {
      const query = sanitizeQuery(params.query);
      const count = normalizeCount(params.count);
      const freshness = typeof params.freshness === "string" ? params.freshness : undefined;

      if (!query) {
        return { content: [{ type: "text", text: '{"error": "query is required"}' }] };
      }

      let lastError: Error | null = null;

      for (const provider of sortedProviders) {
        const currentUsage = getUsage(provider.id);

        if (currentUsage >= provider.monthlyLimit) {
          api.logger?.info(`[web_search_plus] Provider ${provider.id} at limit (${currentUsage}/${provider.monthlyLimit}), skipping`);
          continue;
        }

        const apiKey = resolveApiKey(provider as unknown as { apiKey?: string; apiKeyEnv?: string });
        if (!apiKey) {
          api.logger?.warn(`[web_search_plus] No API key for provider ${provider.id}; skipping`);
          continue;
        }

        try {
          const searchFn = providerRegistry[provider.type] || providerRegistry.custom;
          const extras = provider.type === "custom" ? { baseUrl: provider.baseUrl } : { freshness };

          const result = await searchFn(apiKey, query, count, extras);

          incrementUsage(provider.id);
          api.logger?.info(`[web_search_plus] Used ${provider.id}, count: ${getUsage(provider.id)}/${provider.monthlyLimit}`);

          return { content: [{ type: "text", text: JSON.stringify({ provider: provider.id, query, ...(result as object) }, null, 2) }] };
        } catch (err) {
          const safeMessage = sanitizeErrorMessage(err);
          lastError = new Error(safeMessage);
          api.logger?.warn(`[web_search_plus] ${provider.id} failed: ${safeMessage}`);
          continue;
        }
      }

      return { content: [{ type: "text", text: JSON.stringify({ error: "All providers failed or at limit", lastError: lastError?.message }) }] };
    },
  });

  api.logger?.info("[web_search_plus] Plugin loaded");
}
