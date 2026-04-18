/**
 * Shared ACP (Agent Client Protocol) content helpers — prompt block conversion,
 * tool kind mapping, and session mode state. Used by acp-server.js and remote-server.js.
 *
 * @module acp-content
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Maps smol-agent tool names to ACP tool kinds for approvals and UI. */
export const ACP_TOOL_KIND_MAP = {
  read_file: "read",
  list_files: "read",
  list_sessions: "read",
  grep: "search",
  write_file: "edit",
  replace_in_file: "edit",
  run_command: "execute",
  code_execution: "execute",
  web_search: "fetch",
  web_fetch: "fetch",
  reflect: "think",
  remember: "think",
  recall: "think",
  memory_bank_read: "read",
  memory_bank_write: "edit",
  memory_bank_init: "edit",
  save_context: "think",
  delegate: "other",
  ask_user: "other",
  discover_tools: "think",
  save_plan: "think",
  get_current_plan: "think",
  complete_plan_step: "think",
  load_plan_progress: "think",
  update_plan_status: "think",
  delete_session: "execute",
  rename_session: "edit",
  git: "execute",
  send_letter: "other",
  check_reply: "other",
  read_inbox: "read",
  read_outbox: "read",
  reply_to_letter: "other",
  list_agents: "read",
  link_repos: "edit",
  set_snippet: "edit",
  find_agent_for_task: "search",
  caveman_compress: "think",
};

export function acpToolKind(name) {
  return ACP_TOOL_KIND_MAP[name] || "other";
}

function isPathInsideJail(resolvedPath, jailResolved) {
  const p = resolvedPath.endsWith(path.sep) ? resolvedPath : resolvedPath + path.sep;
  const j = jailResolved.endsWith(path.sep) ? jailResolved : jailResolved + path.sep;
  return resolvedPath === jailResolved || p.startsWith(j);
}

/**
 * Resolve a resource_link URI to an absolute path if it points at a local file inside jail.
 */
export function resourceLinkToSafePath(uri, jailDirectory) {
  if (!uri || typeof uri !== "string") return null;
  const jailResolved = path.resolve(jailDirectory);
  try {
    let abs;
    if (uri.startsWith("file:")) {
      abs = path.resolve(fileURLToPath(uri));
    } else if (uri.startsWith("/")) {
      abs = path.resolve(uri);
    } else {
      return null;
    }
    if (!isPathInsideJail(abs, jailResolved)) return null;
    return abs;
  } catch {
    return null;
  }
}

/**
 * Convert ACP prompt content blocks to a single user message string for the agent.
 * Supports baseline Text + ResourceLink; embedded text resources when embeddedContext is enabled.
 *
 * @param {import("@agentclientprotocol/sdk").ContentBlock[]} blocks
 * @param {string} jailDirectory
 * @param {{ embeddedContext?: boolean }} [opts]
 */
export async function promptBlocksToUserText(blocks, jailDirectory, opts = {}) {
  const embeddedContext = opts.embeddedContext !== false;
  const parts = [];

  for (const block of blocks || []) {
    if (!block || typeof block !== "object") continue;

    if (block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
      continue;
    }

    if (block.type === "resource_link") {
      const uri = block.uri;
      const safe = resourceLinkToSafePath(uri, jailDirectory);
      let body = "";
      if (safe) {
        try {
          body = await fs.readFile(safe, "utf-8");
        } catch (e) {
          body = `(Could not read file: ${e?.message || e})`;
        }
      } else {
        body = `(Resource not loaded: ${uri}${block.name ? ` — ${block.name}` : ""})`;
      }
      const label = block.title || block.name || uri;
      parts.push(`\n---\nContext from ${label} (${uri}):\n${body}\n---\n`);
      continue;
    }

    if (block.type === "resource" && embeddedContext) {
      const res = block.resource;
      if (res && typeof res.text === "string" && "uri" in res) {
        parts.push(`\n---\nEmbedded resource ${res.uri}:\n${res.text}\n---\n`);
        continue;
      }
      if (res && res.blob) {
        parts.push("\n[Binary resource attachment omitted]\n");
        continue;
      }
    }

    if (block.type === "image") {
      parts.push("\n[Image attachment: the current model is text-only; describe the image in text if needed.]\n");
      continue;
    }

    if (block.type === "audio") {
      parts.push("\n[Audio attachment omitted]\n");
      continue;
    }
  }

  return parts.join("\n").trim();
}

const SESSION_MODES = [
  { id: "code", name: "Code", description: "Standard editing and tools" },
  { id: "architect", name: "Architect", description: "Plan-first two-pass analysis" },
  { id: "caveman", name: "Caveman", description: "Compressed caveman communication style" },
];

/**
 * Build ACP SessionModeState from a running Agent instance.
 * @param {{ architectMode?: boolean, cavemanMode?: string | null }} agent
 */
export function getSessionModeState(agent) {
  let currentModeId = "code";
  if (agent.cavemanMode) currentModeId = "caveman";
  else if (agent.architectMode) currentModeId = "architect";
  return {
    availableModes: SESSION_MODES,
    currentModeId,
  };
}

/**
 * Apply session mode to the agent (architect / caveman / default code).
 * @param {import("./agent.js").Agent} agent
 * @param {string} modeId
 */
export function applySessionMode(agent, modeId) {
  if (modeId === "architect") {
    agent.setCavemanMode(null);
    agent.setArchitectMode(true);
  } else if (modeId === "caveman") {
    agent.setArchitectMode(false);
    agent.setCavemanMode("lite");
  } else if (modeId === "code") {
    agent.setArchitectMode(false);
    agent.setCavemanMode(null);
  } else {
    throw new Error(`Unknown mode: ${modeId}`);
  }
}
