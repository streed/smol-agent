import { register } from "./registry.js";

let _client = null;

/**
 * Set the Ollama client instance for web fetch.
 * Called by the agent during initialization.
 */
export function setOllamaClient(client) {
  _client = client;
}

register("web_fetch", {
  description:
    "Fetch a web page by URL using Ollama's web fetch API and return its content as readable text. Use this to read documentation pages, API references, blog posts, or any URL found via web_search.",
  parameters: {
    type: "object",
    required: ["url"],
    properties: {
      url: {
        type: "string",
        description:
          "The full URL to fetch (must start with http:// or https://).",
      },
    },
  },
  async execute({ url }) {
    if (!_client) {
      return { error: "Ollama client not initialized." };
    }

    if (!url.startsWith("http://") && !url.startsWith("https://")) {
      return { error: "URL must start with http:// or https://" };
    }

    // Block requests to private/internal IP ranges and cloud metadata endpoints
    try {
      const parsed = new URL(url);
      const hostname = parsed.hostname.toLowerCase();

      // Block cloud metadata endpoints
      const blockedHosts = [
        "169.254.169.254", "metadata.google.internal",
        "metadata.google.com", "100.100.100.200",
      ];
      if (blockedHosts.includes(hostname)) {
        return { error: "Blocked: requests to cloud metadata endpoints are not allowed" };
      }

      // Block private/reserved IP ranges
      const ipMatch = hostname.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
      if (ipMatch) {
        const [, a, b] = ipMatch.map(Number);
        if (a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) ||
            (a === 192 && b === 168) || a === 0 || (a === 169 && b === 254)) {
          return { error: "Blocked: requests to private/internal IP addresses are not allowed" };
        }
      }

      // Block IPv6 localhost and private ranges
      if (hostname === "[::1]" || hostname === "[::0]" ||
          hostname.startsWith("[fc") || hostname.startsWith("[fd") ||
          hostname.startsWith("[fe80")) {
        return { error: "Blocked: requests to private/internal IPv6 addresses are not allowed" };
      }

      // Block localhost aliases
      if (hostname === "localhost" || hostname.endsWith(".localhost") ||
          hostname.endsWith(".local") || hostname === "[::1]") {
        return { error: "Blocked: requests to localhost are not allowed" };
      }
    } catch {
      return { error: "Invalid URL" };
    }

    const response = await _client.webFetch({ url });

    let content = response.content || "";

    // Truncate to ~12k chars to avoid blowing up the context window
    const MAX = 12_000;
    if (content.length > MAX) {
      content = content.slice(0, MAX) + "\n\n...(truncated)";
    }

    return {
      url,
      title: response.title || "",
      content,
    };
  },
});
