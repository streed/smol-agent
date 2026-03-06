/**
 * Attempt to extract tool calls from assistant text content.
 * Some models output tool calls as JSON instead of using Ollama's
 * native tool_calls field. We try multiple patterns because different
 * model families format them differently.
 *
 * Shared between the main agent and sub-agent to avoid circular imports.
 */
export function parseToolCallsFromContent(content, { markAsTextParsed = true } = {}) {
  if (!content) return [];

  const MAX_PARSED_CALLS = 20;
  const calls = [];
  const candidates = [];

  // 1. Fenced JSON blocks (```json ... ``` or ``` ... ```)
  const jsonBlockRe = /```(?:json)?\s*\n?([\s\S]*?)\n?```/g;
  let match;
  while ((match = jsonBlockRe.exec(content)) !== null) {
    candidates.push(match[1].trim());
    if (candidates.length >= MAX_PARSED_CALLS) break;
  }

  // 2. <tool_call> ... </tool_call> tags (used by some Qwen/Mistral models)
  const toolCallTagRe = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;
  while ((match = toolCallTagRe.exec(content)) !== null) {
    candidates.push(match[1].trim());
    if (candidates.length >= MAX_PARSED_CALLS) break;
  }

  // 3. Bare JSON objects with "name" and "arguments" keys
  const bareJsonRe = /\{\s*"name"\s*:\s*"[^"]+"\s*,\s*"arguments"\s*:\s*\{[\s\S]*?\}\s*\}/g;
  while ((match = bareJsonRe.exec(content)) !== null) {
    candidates.push(match[0].trim());
    if (candidates.length >= MAX_PARSED_CALLS) break;
  }

  // 4. Function-call style:  function_name({"key": "value"})
  const funcCallRe = /([a-z_][a-z0-9_]*)\((\{[\s\S]*?\})\)/gi;
  while ((match = funcCallRe.exec(content)) !== null) {
    if (calls.length >= MAX_PARSED_CALLS) break;
    const name = match[1];
    const argsStr = match[2].trim();
    try {
      const args = JSON.parse(argsStr);
      if (typeof args === "object") {
        calls.push({ function: { name, arguments: args } });
      }
    } catch { /* not valid JSON args */ }
  }

  for (const candidate of candidates) {
    try {
      let parsed = JSON.parse(candidate);
      // Handle arrays of tool calls
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (item.name && typeof item.name === "string" && item.arguments && typeof item.arguments === "object") {
            calls.push({ function: { name: item.name, arguments: item.arguments } });
          }
        }
        continue;
      }
      if (parsed.name && typeof parsed.name === "string" &&
          parsed.arguments && typeof parsed.arguments === "object") {
        calls.push({
          function: { name: parsed.name, arguments: parsed.arguments },
        });
      }
      // Some models wrap in { "function": { "name": ..., "arguments": ... } }
      if (parsed.function?.name && parsed.function?.arguments) {
        calls.push({
          function: { name: parsed.function.name, arguments: parsed.function.arguments },
        });
      }
    } catch { /* not valid JSON */ }
  }

  // Deduplicate — multiple regex patterns can match the same call
  const seen = new Set();
  const deduplicated = calls.filter((c) => {
    const key = JSON.stringify({ name: c.function.name, args: c.function.arguments });
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Mark calls as text-parsed for provenance tracking
  if (markAsTextParsed) {
    for (const call of deduplicated) {
      call._textParsed = true;
    }
  }

  return deduplicated;
}
