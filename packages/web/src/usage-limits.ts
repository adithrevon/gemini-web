/**
 * Claude usage limits tracker
 *
 * Fetches usage limits from Anthropic OAuth API following the approach from:
 * https://codelynx.dev/posts/claude-code-usage-limits-statusline
 */

interface UsageLimitData {
  utilization: number;
  resets_at: string;
}

interface UsageLimits {
  five_hour: UsageLimitData;
  seven_day: UsageLimitData;
}

export class UsageLimitsTracker {
  private accessToken: string;
  private cache: { data: UsageLimits | null; timestamp: number } = {
    data: null,
    timestamp: 0,
  };
  private readonly CACHE_TTL = 60_000; // 60 seconds

  constructor(apiKey: string) {
    // Extract OAuth access token from keychain JSON if needed
    try {
      const parsed = JSON.parse(apiKey);
      if (parsed.claudeAiOauth?.accessToken) {
        this.accessToken = parsed.claudeAiOauth.accessToken;
      } else {
        this.accessToken = apiKey;
      }
    } catch {
      // Not JSON, use as-is
      this.accessToken = apiKey;
    }
  }

  async getUsageLimits(): Promise<UsageLimits | null> {
    const now = Date.now();

    // Return cached data if still fresh
    if (this.cache.data && now - this.cache.timestamp < this.CACHE_TTL) {
      return this.cache.data;
    }

    try {
      // Following the blog post approach:
      // GET https://api.anthropic.com/api/oauth/usage
      // Use Bearer token for OAuth (not x-api-key)
      const response = await fetch('https://api.anthropic.com/api/oauth/usage', {
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          'anthropic-beta': 'oauth-2025-04-20',
          'anthropic-version': '2023-06-01',
        },
      });

      if (!response.ok) {
        console.error('Failed to fetch usage limits:', response.statusText);
        return null;
      }

      const data = (await response.json()) as UsageLimits;

      // Update cache
      this.cache = { data, timestamp: now };
      return data;
    } catch (error) {
      console.error('Error fetching usage limits:', error);
      return null;
    }
  }
}
