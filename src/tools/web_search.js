import { register } from "./registry.js";

const SEARCH_URL = "https://lite.duckduckgo.com/lite/";

register("web_search", {
  description:
    "Search the web using DuckDuckGo and return a list of result titles, URLs, and snippets. Use this to look up documentation, find solutions to errors, research libraries, or get up-to-date information that you don't already know.",
  parameters: {
    type: "object",
    required: ["query"],
    properties: {
      query: {
        type: "string",
        description: "The search query string.",
      },
    },
  },
  async execute({ query }) {
    const response = await fetch(SEARCH_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ q: query }),
      redirect: "follow",
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
      return { error: `Search request failed: HTTP ${response.status}` };
    }

    const html = await response.text();
    const results = parseResults(html);

    if (results.length === 0) {
      return { results: [], message: "No results found." };
    }

    return { results: results.slice(0, 10) };
  },
});

/**
 * Parse DuckDuckGo Lite HTML results into structured objects.
 * The lite page uses a table layout with result links and snippets.
 */
function parseResults(html) {
  const results = [];

  // Match result links: <a rel="nofollow" href="URL" class="result-link">Title</a>
  const linkRe = /<a[^>]+class="result-link"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
  const links = [];
  let m;
  while ((m = linkRe.exec(html)) !== null) {
    links.push({ url: decodeHTMLEntities(m[1]), title: stripTags(m[2]).trim() });
  }

  // Match snippets: <td class="result-snippet">...</td>
  const snippetRe = /<td\s+class="result-snippet">([\s\S]*?)<\/td>/gi;
  const snippets = [];
  while ((m = snippetRe.exec(html)) !== null) {
    snippets.push(stripTags(m[1]).trim());
  }

  for (let i = 0; i < links.length; i++) {
    results.push({
      title: links[i].title,
      url: links[i].url,
      snippet: snippets[i] || "",
    });
  }

  return results;
}

function stripTags(html) {
  return html.replace(/<[^>]*>/g, "");
}

function decodeHTMLEntities(str) {
  return str
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}
