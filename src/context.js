import fs from "node:fs/promises";
import path from "node:path";
import { execSync } from "node:child_process";
import { loadCachedRepoMap, getRepoMapSummary } from "./repo-map.js";

/**
 * Gather project context to inject into the system prompt so the model
 * starts every conversation with awareness of the working environment.
 * @param {string} cwd - Current working directory
 * @param {number} contextSize - Maximum number of lines for README/AGENT.md snippets (default: 100)
 * @param {Object} contextTracker - Optional context tracker for smart updates
 */
export async function gatherContext(cwd, contextSize = 100, contextTracker = null) {
  const sections = [];
  const changedFiles = contextTracker ? contextTracker.getChangedFiles() : [];

  // 1. Working directory
  sections.push(`## Working directory\n${cwd}`);

  // 2. File tree (top 2 levels, ignore noise)
  // If we have changed files, only include those; otherwise include full tree
  if (contextTracker && changedFiles.length > 0) {
    sections.push(`## Project file tree (changed files only)\n${await fileTreeForFiles(cwd, changedFiles, 2)}`);
  } else {
    const tree = await fileTree(cwd, 2);
    if (tree.length > 0) {
      sections.push(`## Project file tree\n${tree.join("\n")}`);
    }
  }

  // 3. Git info
  const git = gitInfo(cwd);
  if (git) {
    sections.push(`## Git status\n${git}`);
  }

  // 4. Key config files — read small metadata files that help the model
  //    understand the project language, dependencies, and scripts.
  const configs = await readConfigs(cwd, [
    "package.json",
    "tsconfig.json",
    "pyproject.toml",
    "Cargo.toml",
    "go.mod",
    "Makefile",
    ".env.example",
  ]);
  if (configs.length > 0) {
    sections.push(
      `## Project configuration files\n${configs.join("\n---\n")}`
    );
  }

  // 5. README snippet (limited by contextSize)
  const readme = await readmeSnippet(cwd, contextSize);
  if (readme) {
    sections.push(`## README (excerpt)\n${readme}`);
  }

  // 6. AGENT.md snippet (limited by contextSize) - important for agent self-awareness
  const agentMd = await agentMdSnippet(cwd, contextSize);
  if (agentMd) {
    sections.push(`## AGENT.md (excerpt)\n${agentMd}`);
  }

  // 7. Repo map
  const repoMap = loadCachedRepoMap(cwd);
  if (repoMap) {
    const repoMapSummary = getRepoMapSummary(repoMap, cwd);
    sections.push(repoMapSummary);
  }

  // Update tracker after gathering context
  if (contextTracker && changedFiles.length === 0) {
    const allFiles = await getAllFiles(cwd, 2);
    contextTracker.updateAfterContextGather(allFiles);
  }

  return sections.join("\n\n");
}

// ── helpers ──────────────────────────────────────────────────────────

async function fileTree(cwd, maxDepth) {
  const entries = [];
  await walk(cwd, "", 0, maxDepth, entries);
  return entries;
}

async function fileTreeForFiles(cwd, files, maxDepth) {
  const entries = [`Total changed files: ${files.length}`, ""]; // Just show the count
  
  for (const file of files) {
    entries.push(`${file}/`);
  }
  
  return entries.join("\n");
}

async function getAllFiles(cwd, maxDepth) {
  const files = [];
  await walkAll(cwd, "", 0, maxDepth, files);
  return files;
}

const IGNORED = new Set([
  "node_modules",
  ".git",
  "__pycache__",
  ".next",
  "dist",
  "build",
  "target",
  ".venv",
  "venv",
  "coverage",
]);

async function walk(base, rel, depth, maxDepth, out) {
  if (depth > maxDepth) return;
  const dir = rel ? path.join(base, rel) : base;
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (IGNORED.has(entry.name)) continue;
    const relPath = rel ? `${rel}/${entry.name}` : entry.name;
    const prefix = "  ".repeat(depth);
    if (entry.isDirectory()) {
      out.push(`${prefix}${entry.name}/`);
      await walk(base, relPath, depth + 1, maxDepth, out);
    } else {
      out.push(`${prefix}${entry.name}`);
    }
  }
}

async function walkAll(base, rel, depth, maxDepth, out) {
  if (depth > maxDepth) return;
  const dir = rel ? path.join(base, rel) : base;
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (IGNORED.has(entry.name)) continue;
    const relPath = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      await walkAll(base, relPath, depth + 1, maxDepth, out);
    } else {
      out.push(relPath);
    }
  }
}

function gitInfo(cwd) {
  try {
    const branch = execSync("git rev-parse --abbrev-ref HEAD", {
      cwd,
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();

    const status = execSync("git status --short", {
      cwd,
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();

    const recentLog = execSync(
      'git log --oneline -5 2>/dev/null || echo "(no commits)"',
      {
        cwd,
        encoding: "utf-8",
        timeout: 5000,
        stdio: ["pipe", "pipe", "pipe"],
      }
    ).trim();

    let out = `Branch: ${branch}`;
    if (status) {
      out += `\nUncommitted changes:\n${status}`;
    } else {
      out += "\nWorking tree clean";
    }
    out += `\nRecent commits:\n${recentLog}`;
    return out;
  } catch {
    return null; // not a git repo
  }
}

async function readConfigs(cwd, filenames) {
  const results = [];
  for (const name of filenames) {
    try {
      const content = await fs.readFile(path.join(cwd, name), "utf-8");
      // Truncate very large config files
      const trimmed =
        content.length > 2000 ? content.slice(0, 2000) + "\n...(truncated)" : content;
      results.push(`### ${name}\n\`\`\`\n${trimmed.trim()}\n\`\`\``);
    } catch {
      // file doesn't exist — skip
    }
  }
  return results;
}

async function readmeSnippet(cwd, contextSize) {
  const candidates = ["README.md", "README", "readme.md", "README.txt"];
  for (const name of candidates) {
    try {
      const raw = await fs.readFile(path.join(cwd, name), "utf-8");
      const lines = raw.split("\n").slice(0, contextSize);
      return lines.join("\n");
    } catch {
      // try next
    }
  }
  return null;
}

async function agentMdSnippet(cwd, contextSize) {
  try {
    const raw = await fs.readFile(path.join(cwd, "AGENT.md"), "utf-8");
    const lines = raw.split("\n").slice(0, contextSize);
    return lines.join("\n");
  } catch {
    return null; // AGENT.md doesn't exist
  }
}
