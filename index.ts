const USAGE_FILE = process.env.HOME + "/.openclaw/data/web_search_plus_usage.json";
const {
  clampCount,
  sanitizeTimeoutMs,
  validateCustomBaseUrl,
  resolveApiKey,
  sanitizeErrorMessage,
} = require("./security");
const {
  DEFAULT_PROVIDER_COOLDOWN_MS,
  sanitizeCooldownMs,
  readUsageFile,
  writeUsageFileAtomic,
  isRetryableProviderError,
  markProviderUnhealthy,
  isProviderHealthy,
} = require("./reliability");

interface ProviderConfig {
  id: string;
  type: string;
  apiKeyEnv?: string;
  apiKey?: string;
  monthlyLimit: number;
  baseUrl?: string;
  timeoutMs?: number;
  cooldownMs?: number;
  allowedHosts?: string[];
}

interface SearchFunction {
  (apiKey: string, query: string, count: number, extras?: Record<string, unknown>): Promise<unknown>;
}

interface ProviderRegistry {
  [key: string]: SearchFunction;
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), sanitizeTimeoutMs(timeoutMs));
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error("Request timed out");
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

const providerRegistry: ProviderRegistry = {
  brave: async (apiKey: string, query: string, count: number, extras?: Record<string, unknown>): Promise<unknown> => {
    const params = new URLSearchParams({ q: query, count: String(count) });
    if (extras?.freshness) params.append("freshness", String(extras.freshness));
    
    const response = await fetchWithTimeout(
      `https://api.search.brave.com/res/v1/web/search?${params}`,
      {
        headers: {
          Accept: "application/json",
          "X-Subscription-Token": apiKey,
        },
      },
      extras?.timeoutMs as number,
    );
    
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
  
  tavily: async (apiKey: string, query: string, count: number, extras?: Record<string, unknown>): Promise<unknown> => {
    const response = await fetchWithTimeout(
      "https://api.tavily.com/search",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, max_results: count, api_key: apiKey }),
      },
      extras?.timeoutMs as number,
    );
    
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
    
    const response = await fetchWithTimeout(
      baseUrl,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, max_results: count, api_key: apiKey }),
      },
      extras?.timeoutMs as number,
    );
    
    if (!response.ok) {
      throw new Error(`Custom provider error: ${response.status}`);
    }
    
    return response.json();
  },
};

let usageData: Record<string, { count: number; month: string }> = {};
const providerUnhealthyUntil: Record<string, number> = {};

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

export default function (api: {
  config: Record<string, unknown>;
  pluginConfig?: Record<string, unknown>;
  registerTool: (tool: unknown) => void;
  logger?: { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void };
}) {
  loadUsage();

  const config = api.pluginConfig as {
    providers?: ProviderConfig[];
    primaryProviderId?: string;
    allowedHosts?: string[];
    cooldownMs?: number;
  } | undefined;

  const providers: ProviderConfig[] = config?.providers || [];
  const primaryProviderId = config?.primaryProviderId || providers[0]?.id;
  const defaultCooldownMs = sanitizeCooldownMs(config?.cooldownMs, DEFAULT_PROVIDER_COOLDOWN_MS);

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
        count: { type: "number", description: "Number of results (default 10)" },
        freshness: { type: "string", enum: ["day", "week", "month"], description: "Filter by freshness (Brave only)" },
      },
      required: ["query"],
    },
    async execute(_toolCallId: string, params: Record<string, unknown>) {
      const query = typeof params.query === "string" ? params.query.trim() : "";
      const count = clampCount(params.count);
      const freshness = typeof params.freshness === "string" ? params.freshness : undefined;

      if (!query) {
        return { content: [{ type: "text", text: '{"error": "query is required"}' }] };
      }

      let lastError: Error | null = null;
      const now = Date.now();

      for (const provider of sortedProviders) {
        if (!isProviderHealthy(providerUnhealthyUntil, provider.id, now)) {
          api.logger?.info(`[web_search_plus] Provider ${provider.id} in cooldown`);
          continue;
        }

        const currentUsage = getUsage(provider.id);
        
        if (currentUsage >= provider.monthlyLimit) {
          api.logger?.info(`[web_search_plus] Provider ${provider.id} at monthly limit`);
          continue;
        }

        const apiKey = resolveApiKey(provider);
        if (!apiKey) {
          api.logger?.warn(`[web_search_plus] No API key for provider ${provider.id}`);
          continue;
        }

        try {
          const searchFn = providerRegistry[provider.type] || providerRegistry.custom;
          const timeoutMs = sanitizeTimeoutMs(provider.timeoutMs);
          const extras =
            provider.type === "custom"
              ? {
                  baseUrl: validateCustomBaseUrl(provider.baseUrl, config?.allowedHosts, provider.allowedHosts),
                  timeoutMs,
                }
              : { freshness, timeoutMs };
          
          const result = await searchFn(apiKey, query, count, extras);

          incrementUsage(provider.id);
          delete providerUnhealthyUntil[provider.id];
          api.logger?.info(`[web_search_plus] Used ${provider.id}`);

          return { content: [{ type: "text", text: JSON.stringify({ provider: provider.id, query, ...(result as object) }, null, 2) }] };
        } catch (err) {
          lastError = err instanceof Error ? err : new Error(String(err));
          api.logger?.warn(`[web_search_plus] ${provider.id} failed: ${sanitizeErrorMessage(lastError)}`);
          if (isRetryableProviderError(lastError)) {
            const cooldownUntil = markProviderUnhealthy(
              providerUnhealthyUntil,
              provider.id,
              sanitizeCooldownMs(provider.cooldownMs, defaultCooldownMs),
            );
            api.logger?.warn(`[web_search_plus] ${provider.id} marked unhealthy until ${new Date(cooldownUntil).toISOString()}`);
          }
          continue;
        }
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ error: "All providers failed or at limit", lastError: lastError ? sanitizeErrorMessage(lastError) : undefined }),
          },
        ],
      };
    },
  });

  api.logger?.info("[web_search_plus] Plugin loaded");
}
