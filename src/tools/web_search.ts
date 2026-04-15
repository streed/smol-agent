import { register } from "./registry.js";

interface SearchResult {
  title: string;
  url: string;
  content?: string;
}

interface WebSearchResponse {
  results?: SearchResult[];
}

interface OllamaClient {
  webSearch: (params: { query: string; max_results: number }) => Promise<WebSearchResponse>;
}

interface WebSearchArgs {
  query: string;
  max_results?: number;
}

interface WebSearchToolResult {
  results?: SearchResult[];
  error?: string;
  message?: string;
}

let _client: OllamaClient | null = null;

/**
 * Set the Ollama client instance for web search.
 * Called by the agent during initialization.
 */
export function setOllamaClient(client: OllamaClient): void {
  _client = client;
}

register("web_search", {
  description:
    "Search the web using Ollama's web search API and return a list of result titles, URLs, and content snippets. Use this to look up documentation, find solutions to errors, research libraries, or get up-to-date information that you don't already know.",
  parameters: {
    type: "object",
    required: ["query"],
    properties: {
      query: {
        type: "string",
        description: "The search query string.",
      },
      max_results: {
        type: "number",
        description:
          "Maximum number of results to return (1-10, default 5).",
      },
    },
  },
  async execute({ query, max_results }: WebSearchArgs): Promise<WebSearchToolResult> {
    if (!_client) {
      return { error: "Ollama client not initialized." };
    }

    const response = await _client.webSearch({
      query,
      max_results: max_results || 5,
    });

    if (!response.results || response.results.length === 0) {
      return { results: [], message: "No results found." };
    }

    return { results: response.results };
  },
});