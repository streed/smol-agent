/**
 * Global Agent Registry
 *
 * Maintains a global config at ~/.config/smol-agent/agents.json that maps
 * repo paths to agent metadata. Agents self-register on startup so other
 * agents can discover and communicate with them.
 *
 * Registry structure:
 *   {
 *     "agents": {
 *       "/absolute/path/to/repo": {
 *         "name": "backend-api",
 *         "path": "/absolute/path/to/repo",
 *         "role": "backend",
 *         "description": "REST API service",
 *         "snippet": "Exposes REST endpoints: GET/POST /users, GET/POST /products. Uses PostgreSQL. Auth via JWT.",
 *         "relations": [
 *           { "repo": "/path/to/frontend", "type": "serves" }
 *         ],
 *         "lastSeen": "2025-01-15T10:00:00.000Z",
 *         "registeredAt": "2025-01-14T08:00:00.000Z"
 *       }
 *     }
 *   }
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { logger } from "./logger.js";

const XDG_CONFIG_HOME =
  process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
const REGISTRY_DIR = path.join(XDG_CONFIG_HOME, "smol-agent");
const REGISTRY_FILE = path.join(REGISTRY_DIR, "agents.json");

// ── Read / write ──────────────────────────────────────────────────────

/**
 * Load the global agent registry from disk.
 * Returns { agents: { [path]: AgentEntry } }.
 */
export function loadRegistry() {
  try {
    if (!fs.existsSync(REGISTRY_FILE)) {
      return { agents: {} };
    }
    const data = JSON.parse(fs.readFileSync(REGISTRY_FILE, "utf-8"));
    return { agents: data.agents || {} };
  } catch (err) {
    logger.warn(`Failed to load agent registry: ${err.message}`);
    return { agents: {} };
  }
}

/**
 * Save the registry to disk.
 */
export function saveRegistry(registry) {
  fs.mkdirSync(REGISTRY_DIR, { recursive: true });
  fs.writeFileSync(
    REGISTRY_FILE,
    JSON.stringify(registry, null, 2),
    "utf-8",
  );
}

// ── Registration ──────────────────────────────────────────────────────

/**
 * Register (or update) an agent in the global registry.
 *
 * Called automatically on agent startup. Merges with existing entry
 * so user-configured fields (name, role, relations) are preserved.
 *
 * @param {object} opts
 * @param {string} opts.repoPath - Absolute path to the repo
 * @param {string} [opts.name]   - Human-friendly name (default: directory basename)
 * @param {string} [opts.role]   - Role hint (e.g., "backend", "frontend", "shared")
 * @param {string} [opts.description] - Short description of this repo/agent
 * @param {string} [opts.snippet] - Longer description of what this repo provides/exposes,
 *   used by other agents to automatically find the right repo to communicate with
 * @returns {object} The registered entry
 */
export function registerAgent({
  repoPath,
  name,
  role,
  description,
  snippet,
}) {
  const resolved = path.resolve(repoPath);
  const registry = loadRegistry();
  const existing = registry.agents[resolved] || {};

  const entry = {
    ...existing,
    name: name || existing.name || path.basename(resolved),
    path: resolved,
    role: role || existing.role || "",
    description: description || existing.description || "",
    snippet: snippet || existing.snippet || "",
    relations: existing.relations || [],
    registeredAt: existing.registeredAt || new Date().toISOString(),
    lastSeen: new Date().toISOString(),
  };

  registry.agents[resolved] = entry;
  saveRegistry(registry);
  logger.info(`Agent registered: ${entry.name} (${resolved})`);
  return entry;
}

/**
 * Update just the lastSeen timestamp for an agent.
 * Lightweight — called on every startup without overwriting user config.
 */
export function touchAgent(repoPath) {
  const resolved = path.resolve(repoPath);
  const registry = loadRegistry();

  if (!registry.agents[resolved]) {
    // First time — auto-register with defaults
    return registerAgent({ repoPath: resolved });
  }

  registry.agents[resolved].lastSeen = new Date().toISOString();
  saveRegistry(registry);
  return registry.agents[resolved];
}

/**
 * Remove an agent from the registry.
 */
export function unregisterAgent(repoPath) {
  const resolved = path.resolve(repoPath);
  const registry = loadRegistry();

  if (!registry.agents[resolved]) {
    return false;
  }

  delete registry.agents[resolved];
  saveRegistry(registry);
  logger.info(`Agent unregistered: ${resolved}`);
  return true;
}

// ── Querying ──────────────────────────────────────────────────────────

/**
 * List all registered agents.
 *
 * @param {object} [filter]
 * @param {string} [filter.role] - Filter by role
 * @returns {Array} Agent entries
 */
export function listAgents(filter = {}) {
  const registry = loadRegistry();
  let agents = Object.values(registry.agents);

  if (filter.role) {
    agents = agents.filter((a) => a.role === filter.role);
  }

  // Sort by lastSeen (most recent first)
  agents.sort(
    (a, b) => new Date(b.lastSeen).getTime() - new Date(a.lastSeen).getTime(),
  );

  return agents;
}

/**
 * Find an agent by name (case-insensitive partial match) or exact path.
 *
 * @param {string} query - Name or path to search for
 * @returns {object|null} Matching agent entry or null
 */
export function findAgent(query) {
  const registry = loadRegistry();

  // Exact path match
  const resolved = path.resolve(query);
  if (registry.agents[resolved]) {
    return registry.agents[resolved];
  }

  // Name match (case-insensitive)
  const lower = query.toLowerCase();
  const agents = Object.values(registry.agents);

  // Exact name match first
  const exact = agents.find((a) => a.name.toLowerCase() === lower);
  if (exact) return exact;

  // Partial name match
  const partial = agents.filter((a) =>
    a.name.toLowerCase().includes(lower),
  );
  if (partial.length === 1) return partial[0];

  // Basename match (e.g., "backend" matches "/home/user/my-backend")
  const basename = agents.find(
    (a) => path.basename(a.path).toLowerCase() === lower,
  );
  if (basename) return basename;

  return null;
}

// ── Relations ─────────────────────────────────────────────────────────

/**
 * Add a relationship between two agents.
 *
 * @param {string} fromRepo - Source repo path
 * @param {string} toRepo   - Target repo path
 * @param {string} type     - Relationship type (e.g., "depends-on", "serves", "consumes", "related")
 */
export function addRelation(fromRepo, toRepo, type = "related") {
  const fromResolved = path.resolve(fromRepo);
  const toResolved = path.resolve(toRepo);
  const registry = loadRegistry();

  if (!registry.agents[fromResolved]) {
    registerAgent({ repoPath: fromResolved });
  }

  const agent = registry.agents[fromResolved];
  // Avoid duplicate relations
  const exists = agent.relations.some(
    (r) => r.repo === toResolved && r.type === type,
  );
  if (!exists) {
    agent.relations.push({ repo: toResolved, type });
    saveRegistry(registry);
    logger.info(`Relation added: ${fromResolved} --${type}--> ${toResolved}`);
  }

  return agent;
}

/**
 * Get all agents related to a given repo.
 *
 * @param {string} repoPath
 * @returns {Array<{ agent: object, type: string, direction: "outgoing"|"incoming" }>}
 */
export function getRelatedAgents(repoPath) {
  const resolved = path.resolve(repoPath);
  const registry = loadRegistry();
  const results = [];

  // Outgoing relations (this repo → others)
  const self = registry.agents[resolved];
  if (self) {
    for (const rel of self.relations) {
      const target = registry.agents[rel.repo];
      if (target) {
        results.push({ agent: target, type: rel.type, direction: "outgoing" });
      }
    }
  }

  // Incoming relations (others → this repo)
  for (const agent of Object.values(registry.agents)) {
    if (agent.path === resolved) continue;
    for (const rel of agent.relations) {
      if (rel.repo === resolved) {
        results.push({ agent, type: rel.type, direction: "incoming" });
      }
    }
  }

  return results;
}

/**
 * Auto-detect repo metadata for self-registration.
 * Reads package.json, pyproject.toml, etc. to infer name and description.
 *
 * @param {string} repoPath
 * @returns {{ name?: string, description?: string }}
 */
export function detectRepoMetadata(repoPath) {
  const resolved = path.resolve(repoPath);
  const result = {};

  // Try package.json
  const pkgPath = path.join(resolved, "package.json");
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
      if (pkg.name) result.name = pkg.name;
      if (pkg.description) result.description = pkg.description;
    } catch {
      // ignore
    }
  }

  // Try pyproject.toml (basic parsing)
  const pyprojectPath = path.join(resolved, "pyproject.toml");
  if (!result.name && fs.existsSync(pyprojectPath)) {
    try {
      const content = fs.readFileSync(pyprojectPath, "utf-8");
      const nameMatch = content.match(/^name\s*=\s*"(.+)"/m);
      if (nameMatch) result.name = nameMatch[1];
      const descMatch = content.match(/^description\s*=\s*"(.+)"/m);
      if (descMatch) result.description = descMatch[1];
    } catch {
      // ignore
    }
  }

  // Try Cargo.toml
  const cargoPath = path.join(resolved, "Cargo.toml");
  if (!result.name && fs.existsSync(cargoPath)) {
    try {
      const content = fs.readFileSync(cargoPath, "utf-8");
      const nameMatch = content.match(/^name\s*=\s*"(.+)"/m);
      if (nameMatch) result.name = nameMatch[1];
      const descMatch = content.match(/^description\s*=\s*"(.+)"/m);
      if (descMatch) result.description = descMatch[1];
    } catch {
      // ignore
    }
  }

  // Try go.mod
  const goModPath = path.join(resolved, "go.mod");
  if (!result.name && fs.existsSync(goModPath)) {
    try {
      const content = fs.readFileSync(goModPath, "utf-8");
      const moduleMatch = content.match(/^module\s+(.+)/m);
      if (moduleMatch) {
        // Use last path segment as name
        const parts = moduleMatch[1].trim().split("/");
        result.name = parts[parts.length - 1];
      }
    } catch {
      // ignore
    }
  }

  // Fallback to directory basename
  if (!result.name) {
    result.name = path.basename(resolved);
  }

  return result;
}

/**
 * Auto-detect a snippet from the repo's AGENT.md or README.
 * Reads the first meaningful paragraph as a description of what the repo does.
 *
 * @param {string} repoPath
 * @returns {string} A snippet, or empty string
 */
export function detectSnippet(repoPath) {
  const resolved = path.resolve(repoPath);

  // Try .smol-agent/snippet.md first (user-authored)
  const snippetPath = path.join(resolved, ".smol-agent", "snippet.md");
  if (fs.existsSync(snippetPath)) {
    try {
      return fs.readFileSync(snippetPath, "utf-8").trim().slice(0, 2048);
    } catch {
      // ignore
    }
  }

  // Try AGENT.md — look for a "Project Overview" or first paragraph
  const agentMdPath = path.join(resolved, "AGENT.md");
  if (fs.existsSync(agentMdPath)) {
    try {
      const content = fs.readFileSync(agentMdPath, "utf-8");
      // Find text between first heading and second heading
      const match = content.match(/^#[^#].*\n\n([\s\S]*?)(?=\n##|\n$)/m);
      if (match && match[1].trim().length > 20) {
        return match[1].trim().slice(0, 2048);
      }
    } catch {
      // ignore
    }
  }

  return "";
}

/**
 * Update specific fields of a registered agent without overwriting others.
 *
 * @param {string} repoPath
 * @param {object} fields - Fields to update (name, role, description, snippet)
 * @returns {object|null} Updated entry or null if not found
 */
export function updateAgent(repoPath, fields) {
  const resolved = path.resolve(repoPath);
  const registry = loadRegistry();

  if (!registry.agents[resolved]) {
    return null;
  }

  const entry = registry.agents[resolved];
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined && value !== null) {
      entry[key] = value;
    }
  }

  saveRegistry(registry);
  logger.info(`Agent updated: ${entry.name} (${resolved})`);
  return entry;
}

/**
 * Remove a specific relation between two agents.
 *
 * @param {string} fromRepo
 * @param {string} toRepo
 * @param {string} [type] - If specified, only remove this relation type. Otherwise remove all.
 * @returns {boolean} Whether any relation was removed
 */
export function removeRelation(fromRepo, toRepo, type) {
  const fromResolved = path.resolve(fromRepo);
  const toResolved = path.resolve(toRepo);
  const registry = loadRegistry();

  if (!registry.agents[fromResolved]) return false;

  const agent = registry.agents[fromResolved];
  const before = agent.relations.length;

  agent.relations = agent.relations.filter((r) => {
    if (r.repo !== toResolved) return true;
    if (type && r.type !== type) return true;
    return false;
  });

  if (agent.relations.length < before) {
    saveRegistry(registry);
    logger.info(`Relation removed: ${fromResolved} -x-> ${toResolved}`);
    return true;
  }

  return false;
}

/**
 * Find the best agent to handle a task based on snippet matching.
 *
 * Scores each registered agent's snippet and description against the query
 * using keyword overlap. Returns agents sorted by relevance.
 *
 * @param {string} query - Description of the task/need
 * @param {string} [excludeRepo] - Repo path to exclude (self)
 * @returns {Array<{ agent: object, score: number }>}
 */
export function findAgentForTask(query, excludeRepo) {
  const agents = listAgents();
  const excludeResolved = excludeRepo ? path.resolve(excludeRepo) : null;

  // Tokenize query into keywords (lowercase, strip punctuation)
  const queryWords = new Set(
    query
      .toLowerCase()
      .replace(/[^\w\s-]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2),
  );

  const scored = [];
  for (const agent of agents) {
    if (agent.path === excludeResolved) continue;

    // Build searchable text from snippet + description + name + role
    const searchText = [
      agent.snippet || "",
      agent.description || "",
      agent.name || "",
      agent.role || "",
    ]
      .join(" ")
      .toLowerCase();

    if (!searchText.trim()) continue;

    const searchWords = new Set(
      searchText
        .replace(/[^\w\s-]/g, " ")
        .split(/\s+/)
        .filter((w) => w.length > 2),
    );

    // Score = number of overlapping keywords
    let score = 0;
    for (const word of queryWords) {
      if (searchWords.has(word)) score++;
    }

    // Bonus for role match
    if (agent.role && queryWords.has(agent.role.toLowerCase())) {
      score += 2;
    }

    if (score > 0) {
      scored.push({ agent, score });
    }
  }

  // Sort by score descending
  scored.sort((a, b) => b.score - a.score);
  return scored;
}
