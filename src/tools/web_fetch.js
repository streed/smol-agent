import { register } from "./registry.js";

register("web_fetch", {
  description:
    "Fetch a web page by URL and return its text content. HTML is converted to readable plain text. Use this to read documentation pages, API references, blog posts, or any URL found via web_search. For large pages the content is truncated to stay within reasonable limits.",
  parameters: {
    type: "object",
    required: ["url"],
    properties: {
      url: {
        type: "string",
        description: "The full URL to fetch (must start with http:// or https://).",
      },
    },
  },
  async execute({ url }) {
    if (!url.startsWith("http://") && !url.startsWith("https://")) {
      return { error: "URL must start with http:// or https://" };
    }

    const response = await fetch(url, {
      headers: {
        "User-Agent": "smol-agent/1.0",
        Accept: "text/html, application/json, text/plain, */*",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(20_000),
    });

    if (!response.ok) {
      return { error: `Fetch failed: HTTP ${response.status}` };
    }

    const contentType = response.headers.get("content-type") || "";
    const raw = await response.text();

    let text;
    if (contentType.includes("text/html")) {
      text = htmlToText(raw);
    } else {
      text = raw;
    }

    // Truncate to ~12k chars to avoid blowing up the context window
    const MAX = 12_000;
    if (text.length > MAX) {
      text = text.slice(0, MAX) + "\n\n...(truncated)";
    }

    return { url, content: text };
  },
});

/**
 * Minimal HTML-to-text conversion. Strips tags, decodes common entities,
 * and collapses whitespace while preserving basic block structure.
 */
function htmlToText(html) {
  let text = html;

  // Remove script, style, and head blocks entirely
  text = text.replace(/<script[\s\S]*?<\/script>/gi, "");
  text = text.replace(/<style[\s\S]*?<\/style>/gi, "");
  text = text.replace(/<head[\s\S]*?<\/head>/gi, "");

  // Convert some block elements to newlines
  text = text.replace(/<\/(p|div|li|tr|h[1-6]|blockquote|pre|section|article)>/gi, "\n");
  text = text.replace(/<br\s*\/?>/gi, "\n");
  text = text.replace(/<hr\s*\/?>/gi, "\n---\n");

  // Strip remaining tags
  text = text.replace(/<[^>]*>/g, "");

  // Decode common HTML entities
  text = text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));

  // Collapse whitespace: multiple blank lines → double newline, trim lines
  text = text
    .split("\n")
    .map((l) => l.trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return text;
}
