# web_search_plus

Multi-provider web search plugin for OpenClaw with automatic fallback and monthly usage limits.

## Features

- **Multi-provider support**: Configure multiple search providers (Brave, Tavily, or custom)
- **Automatic fallback**: When primary provider hits limit, automatically falls back to next provider
- **Monthly usage tracking**: Usage resets automatically at the start of each month
- **Extensible**: Add any HTTP-based search API as a custom provider
- **Secure**: API keys stored in environment variables, not in config

## Installation

1. Copy this plugin to your OpenClaw extensions directory:
   ```
   ~/.openclaw/extensions/web_search_plus/
   ```

2. Add to your `openclaw.json`:

```json
{
  "plugins": {
    "allow": ["web_search_plus"],
    "entries": {
      "web_search_plus": {
        "enabled": true,
        "config": {
          "primaryProviderId": "brave",
          "providers": [
            {
              "id": "brave",
              "type": "brave",
              "apiKeyEnv": "BRAVE_API_KEY",
              "monthlyLimit": 1000
            },
            {
              "id": "tavily",
              "type": "tavily",
              "apiKeyEnv": "TAVILY_API_KEY",
              "monthlyLimit": 1000
            }
          ]
        }
      }
    }
  },
  "agents": {
    "list": [{
      "id": "main",
      "tools": {
        "alsoAllow": ["web_search"]
      }
    }]
  },
  "tools": {
    "web": {
      "search": {
        "enabled": false
      }
    }
  }
}
```

3. Add API keys to env block (or set as environment variables):

```json
{
  "env": {
    "BRAVE_API_KEY": "your-brave-api-key",
    "TAVILY_API_KEY": "your-tavily-api-key"
  }
}
```

4. Restart the gateway:
   ```
   openclaw gateway restart
   ```

## Configuration

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `providers` | array | Yes | List of search providers |
| `providers[].id` | string | Yes | Unique identifier for this provider |
| `providers[].type` | string | Yes | `brave`, `tavily`, or `custom` |
| `providers[].apiKeyEnv` | string | Yes | Env var name containing API key |
| `providers[].monthlyLimit` | number | Yes | Maximum requests per month |
| `providers[].baseUrl` | string | No | Custom API URL (only for type=`custom`) |
| `primaryProviderId` | string | No | ID of primary provider (default: first provider) |

## Built-in Providers

### Brave Search
- Type: `brave`
- API Key: Get from https://brave.com/search/api/
- Supports `freshness` parameter (day/week/month)

### Tavily
- Type: `tavily`
- API Key: Get from https://tavily.com/
- No extra parameters

## Custom Provider

Add any HTTP-based search API:

```json
{
  "id": "my-custom",
  "type": "custom",
  "apiKeyEnv": "MY_API_KEY",
  "monthlyLimit": 500,
  "baseUrl": "https://api.mysearch.com/search"
}
```

The custom provider sends POST request with:
```json
{
  "query": "search term",
  "max_results": 10,
  "api_key": "your-key"
}
```

## Usage

The plugin automatically replaces the built-in `web_search` tool. Usage:

```python
# Agent will automatically use this plugin when searching the web
# No code changes needed - just ask the agent to search for something
```

## Usage Tracking

Usage is stored in `~/.openclaw/data/web_search_plus_usage.json` and resets automatically at the start of each month.

## License

MIT
