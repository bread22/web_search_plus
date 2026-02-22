const USAGE_FILE = process.env.HOME + "/.openclaw/data/web_search_plus_usage.json";

interface ProviderConfig {
  id: string;
  type: string;
  apiKeyEnv: string;
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
      body: JSON.stringify({ query, max_results: count, api_key: apiKey, ...extras }),
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
    const fs = require("fs");
    if (fs.existsSync(USAGE_FILE)) {
      const data = JSON.parse(fs.readFileSync(USAGE_FILE, "utf-8"));
      const currentMonth = getCurrentMonth();
      for (const [providerId, info] of Object.entries(data)) {
        if (typeof info === "object" && info.month !== currentMonth) {
          info.count = 0;
          info.month = currentMonth;
        }
      }
      usageData = data;
    }
  } catch {
    usageData = {};
  }
}

function saveUsage(): void {
  try {
    const fs = require("fs");
    const dir = USAGE_FILE.substring(0, USAGE_FILE.lastIndexOf("/"));
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(USAGE_FILE, JSON.stringify(usageData, null, 2));
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

function getApiKey(envVar: string, fallbackPath?: string): string {
  const fs = require("fs");
  
  if (process.env[envVar]) {
    return process.env[envVar];
  }
  
  if (fallbackPath && fs.existsSync(fallbackPath)) {
    return fs.readFileSync(fallbackPath, "utf-8").trim();
  }
  
  return "";
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
  } | undefined;

  const providers: ProviderConfig[] = config?.providers || [];
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
        count: { type: "number", description: "Number of results (default 10)" },
        freshness: { type: "string", enum: ["day", "week", "month"], description: "Filter by freshness (Brave only)" },
      },
      required: ["query"],
    },
    async execute(_toolCallId: string, params: Record<string, unknown>) {
      const query = typeof params.query === "string" ? params.query.trim() : "";
      const count = typeof params.count === "number" ? params.count : 10;
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

        const apiKey = getApiKey(provider.apiKeyEnv, provider.apiKeyEnv);
        if (!apiKey) {
          api.logger?.warn(`[web_search_plus] No API key for provider ${provider.id} (env: ${provider.apiKeyEnv})`);
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
          lastError = err instanceof Error ? err : new Error(String(err));
          api.logger?.warn(`[web_search_plus] ${provider.id} failed: ${lastError.message}`);
          continue;
        }
      }

      return { content: [{ type: "text", text: JSON.stringify({ error: "All providers failed or at limit", lastError: lastError?.message })}] };
    },
  });

  api.logger?.info("[web_search_plus] Plugin loaded");
}
