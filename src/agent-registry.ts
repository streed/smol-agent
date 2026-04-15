/**
 * Global Agent Registry
 *
 * Maintains a global config at ~/.config/smol-agent/agents.json that maps
 * repo paths to agent metadata. Agents self-register on startup so other
 * agents can discover and communicate with them.
 *
 * Key features:
 * - mkdir-based file locking for concurrent access safety
 * - Stale lock detection (PID check + age-based fallback)
 * - Atomic saves via temp file + rename
 * - Auto-registration on first startup
 * - Relationship tracking between repos (depends-on, serves, consumes, related)
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
 *
 * Dependencies: node:fs, node:path, node:os, ./logger.js
 * Depended on by: src/agent.js, src/context.js, src/tools/cross_agent.js, src/ui/App.js,
 *                  test/unit/agent-registry.test.js, test/unit/cross-agent-*.test.js
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { logger } from "./logger.js";

const XDG_CONFIG_HOME =
  process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
const REGISTRY_DIR = path.join(XDG_CONFIG_HOME, "smol-agent");
const REGISTRY_FILE = path.join(REGISTRY_DIR, "agents.json");
const LOCK_FILE = path.join(REGISTRY_DIR, "agents.json.lock");
const LOCK_TIMEOUT_MS = 5000;
const LOCK_STALE_MS = 30000;

// ── Types ──────────────────────────────────────────────────────────────

export interface AgentRelation {
  repo: string;
  type: string;
}

export interface AgentEntry {
  name: string;
  path: string;
  role: string;
  description: string;
  snippet: string;
  relations: AgentRelation[];
  registeredAt: string;
  lastSeen: string;
}

export interface Registry {
  agents: Record<string, AgentEntry>;
}

export interface RelatedAgent {
  agent: AgentEntry;
  type: string;
  direction: "outgoing" | "incoming";
}

export interface RegisterOptions {
  repoPath: string;
  name?: string;
  role?: string;
  description?: string;
  snippet?: string;
}

export interface ListAgentsFilter {
  role?: string;
}

export interface ScoredAgent {
  agent: AgentEntry;
  score: number;
}

// ── File locking ──────────────────────────────────────────────────────

// Shared buffer used by Atomics.wait() for non-spinning delays in acquireLock.
// SharedArrayBuffer is available in Node.js 16+ without special flags.
const _lockWaitBuffer = new Int32Array(new SharedArrayBuffer(4));

/**
 * Acquire an exclusive lock on the registry file.
 * Uses mkdir-based locking (atomic on all platforms).
 * Throws an error if the lock cannot be acquired within LOCK_TIMEOUT_MS.
 * Call releaseLock() when done.
 */
function acquireLock(): void {
  fs.mkdirSync(REGISTRY_DIR, { recursive: true });
  const start = Date.now();

  while (true) {
    try {
      fs.mkdirSync(LOCK_FILE);
      // Write our PID so stale locks can be detected
      fs.writeFileSync(path.join(LOCK_FILE, "pid"), String(process.pid));
      return;
    } catch (err) {
      const error = err as NodeJS.ErrnoException;
      if (error.code !== "EEXIST") throw err;

      // Check for stale lock (process died without releasing)
      try {
        const pidFile = path.join(LOCK_FILE, "pid");
        if (fs.existsSync(pidFile)) {
          const lockPid = parseInt(fs.readFileSync(pidFile, "utf-8"), 10);
          let processAlive = true;
          try { process.kill(lockPid, 0); } catch { processAlive = false; }
          if (!processAlive) {
            // Stale lock — remove and retry
            fs.rmSync(LOCK_FILE, { recursive: true, force: true });
            continue;
          }
        }
      } catch {
        // If we can't read the pid file, check age-based staleness
      }

      // Check age-based staleness as fallback
      try {
        const stat = fs.statSync(LOCK_FILE);
        if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
          fs.rmSync(LOCK_FILE, { recursive: true, force: true });
          continue;
        }
      } catch {
        // Lock dir was removed between our check — retry
        continue;
      }

      if (Date.now() - start > LOCK_TIMEOUT_MS) {
        // The lock is held by a live process and we've waited long enough;
        // do NOT force-break it (that would corrupt the other writer's session).
        logger.warn("Registry lock acquisition timed out; lock appears non-stale");
        throw new Error("Timed out acquiring registry lock");
      }

      // Non-spinning delay: Atomics.wait blocks the thread without consuming CPU.
      const waitMs = 10 + Math.random() * 40;
      Atomics.wait(_lockWaitBuffer, 0, 0, waitMs);
    }
  }
}

function releaseLock(): void {
  try {
    fs.rmSync(LOCK_FILE, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup
  }
}

/**
 * Execute a function while holding the registry lock.
 * The function receives the current registry and should return the
 * (possibly modified) registry. If it returns a registry, it is saved.
 */
function withRegistryLock<T>(fn: () => T): T {
  acquireLock();
  try {
    return fn();
  } finally {
    releaseLock();
  }
}

// ── Read / write ──────────────────────────────────────────────────────

/**
 * Load the global agent registry from disk.
 * Returns { agents: { [path]: AgentEntry } }.
 */
export function loadRegistry(): Registry {
  try {
    if (!fs.existsSync(REGISTRY_FILE)) {
      return { agents: {} };
    }
    const data = JSON.parse(fs.readFileSync(REGISTRY_FILE, "utf-8"));
    return { agents: data.agents || {} };
  } catch (err) {
    const error = err as Error;
    logger.warn(`Failed to load agent registry: ${error.message}`);
    return { agents: {} };
  }
}

/**
 * Save the registry to disk atomically (write to temp file, then rename).
 * This prevents readers from observing partially-written JSON.
 */
export function saveRegistry(registry: Registry): void {
  fs.mkdirSync(REGISTRY_DIR, { recursive: true });
  const tmpFile = `${REGISTRY_FILE}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmpFile, JSON.stringify(registry, null, 2), "utf-8");
    fs.renameSync(tmpFile, REGISTRY_FILE);
  } catch (err) {
    try { fs.rmSync(tmpFile, { force: true }); } catch { /* ignore */ }
    throw err;
  }
}

// ── Registration ──────────────────────────────────────────────────────

/**
 * Register (or update) an agent in the global registry.
 *
 * Called automatically on agent startup. Merges with existing entry
 * so user-configured fields (name, role, relations) are preserved.
 *
 * @param opts - Registration options
 * @returns The registered entry
 */
export function registerAgent({
  repoPath,
  name,
  role,
  description,
  snippet,
}: RegisterOptions): AgentEntry {
  const resolved = path.resolve(repoPath);

  return withRegistryLock(() => {
    const registry = loadRegistry();
    const existing = registry.agents[resolved] || {} as Partial<AgentEntry>;

    const entry: AgentEntry = {
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
  });
}

/**
 * Update just the lastSeen timestamp for an agent.
 * Lightweight — called on every startup without overwriting user config.
 */
export function touchAgent(repoPath: string): AgentEntry {
  const resolved = path.resolve(repoPath);

  return withRegistryLock(() => {
    const registry = loadRegistry();

    if (!registry.agents[resolved]) {
      // First time — inline registration to avoid nested lock acquisition
      const entry: AgentEntry = {
        name: path.basename(resolved),
        path: resolved,
        role: "",
        description: "",
        snippet: "",
        relations: [],
        registeredAt: new Date().toISOString(),
        lastSeen: new Date().toISOString(),
      };
      registry.agents[resolved] = entry;
      saveRegistry(registry);
      logger.info(`Agent registered: ${entry.name} (${resolved})`);
      return entry;
    }

    registry.agents[resolved].lastSeen = new Date().toISOString();
    saveRegistry(registry);
    return registry.agents[resolved];
  });
}

/**
 * Remove an agent from the registry.
 */
export function unregisterAgent(repoPath: string): boolean {
  const resolved = path.resolve(repoPath);

  return withRegistryLock(() => {
    const registry = loadRegistry();

    if (!registry.agents[resolved]) {
      return false;
    }

    delete registry.agents[resolved];
    saveRegistry(registry);
    logger.info(`Agent unregistered: ${resolved}`);
    return true;
  });
}

// ── Querying ──────────────────────────────────────────────────────────

/**
 * List all registered agents.
 *
 * @param filter - Optional filter criteria
 * @returns Agent entries
 */
export function listAgents(filter: ListAgentsFilter = {}): AgentEntry[] {
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
 * @param query - Name or path to search for
 * @returns Matching agent entry or null
 */
export function findAgent(query: string): AgentEntry | null {
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
 * @param fromRepo - Source repo path
 * @param toRepo - Target repo path
 * @param type - Relationship type (e.g., "depends-on", "serves", "consumes", "related")
 */
export function addRelation(fromRepo: string, toRepo: string, type = "related"): AgentEntry {
  const fromResolved = path.resolve(fromRepo);
  const toResolved = path.resolve(toRepo);

  return withRegistryLock(() => {
    const registry = loadRegistry();

    if (!registry.agents[fromResolved]) {
      // Inline registration to avoid nested lock acquisition
      registry.agents[fromResolved] = {
        name: path.basename(fromResolved),
        path: fromResolved,
        role: "",
        description: "",
        snippet: "",
        relations: [],
        registeredAt: new Date().toISOString(),
        lastSeen: new Date().toISOString(),
      };
      logger.info(`Agent registered: ${path.basename(fromResolved)} (${fromResolved})`);
    }

    const agent = registry.agents[fromResolved];
    // Avoid duplicate relations
    const exists = agent.relations.some(
      (r) => r.repo === toResolved && r.type === type,
    );
    if (!exists) {
      agent.relations.push({ repo: toResolved, type });
      logger.info(`Relation added: ${fromResolved} --${type}--> ${toResolved}`);
    }

    saveRegistry(registry);
    return agent;
  });
}

/**
 * Get all agents related to a given repo.
 *
 * @param repoPath - Repo path to find relations for
 * @returns Array of related agents with relation type and direction
 */
export function getRelatedAgents(repoPath: string): RelatedAgent[] {
  const resolved = path.resolve(repoPath);
  const registry = loadRegistry();
  const results: RelatedAgent[] = [];

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
 * @param repoPath - Repo path to analyze
 * @returns Detected metadata
 */
export function detectRepoMetadata(repoPath: string): { name?: string; description?: string } {
  const resolved = path.resolve(repoPath);
  const result: { name?: string; description?: string } = {};

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
 * @param repoPath - Repo path to analyze
 * @returns A snippet, or empty string
 */
export function detectSnippet(repoPath: string): string {
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
 * @param repoPath - Repo path to update
 * @param fields - Fields to update (name, role, description, snippet)
 * @returns Updated entry or null if not found
 */
export function updateAgent(repoPath: string, fields: Partial<AgentEntry>): AgentEntry | null {
  const resolved = path.resolve(repoPath);

  return withRegistryLock(() => {
    const registry = loadRegistry();

    if (!registry.agents[resolved]) {
      return null;
    }

    const entry = registry.agents[resolved];
    Object.assign(entry, fields);

    saveRegistry(registry);
    logger.info(`Agent updated: ${entry.name} (${resolved})`);
    return entry;
  });
}

/**
 * Remove a specific relation between two agents.
 *
 * @param fromRepo - Source repo path
 * @param toRepo - Target repo path
 * @param type - If specified, only remove this relation type. Otherwise remove all.
 * @returns Whether any relation was removed
 */
export function removeRelation(fromRepo: string, toRepo: string, type?: string): boolean {
  const fromResolved = path.resolve(fromRepo);
  const toResolved = path.resolve(toRepo);

  return withRegistryLock(() => {
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
  });
}

/**
 * Find the best agent to handle a task based on snippet matching.
 *
 * Scores each registered agent's snippet and description against the query
 * using keyword overlap. Returns agents sorted by relevance.
 *
 * @param query - Description of the task/need
 * @param excludeRepo - Repo path to exclude (self)
 * @returns Array of scored agents
 */
export function findAgentForTask(query: string, excludeRepo?: string): ScoredAgent[] {
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

  const scored: ScoredAgent[] = [];
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

  // Sort by score descending; alphabetical name as a stable tiebreaker
  scored.sort(
    (a, b) => b.score - a.score || a.agent.name.localeCompare(b.agent.name),
  );
  return scored;
}