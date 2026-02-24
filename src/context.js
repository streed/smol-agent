import fs from "node:fs/promises";
import path from "node:path";
import { execSync } from "node:child_process";

/**
 * Gather project context to inject into the system prompt so the model
 * starts every conversation with awareness of the working environment.
 */
export async function gatherContext(cwd) {
  const sections = [];

  // 1. Working directory
  sections.push(`## Working directory\n${cwd}`);

  // 2. File tree (top 2 levels, ignore noise)
  const tree = await fileTree(cwd, 2);
  if (tree.length > 0) {
    sections.push(`## Project file tree\n${tree.join("\n")}`);
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

  // 5. README snippet (first 80 lines)
  const readme = await readmeSnippet(cwd);
  if (readme) {
    sections.push(`## README (excerpt)\n${readme}`);
  }

  return sections.join("\n\n");
}

// ── helpers ──────────────────────────────────────────────────────────

async function fileTree(cwd, maxDepth) {
  const entries = [];
  await walk(cwd, "", 0, maxDepth, entries);
  return entries;
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
  const results = await Promise.all(
    filenames.map(async (name) => {
      try {
        const content = await fs.readFile(path.join(cwd, name), "utf-8");
        // Truncate very large config files
        const trimmed =
          content.length > 2000 ? content.slice(0, 2000) + "\n...(truncated)" : content;
        return `### ${name}\n\`\`\`\n${trimmed.trim()}\n\`\`\``;
      } catch {
        return null; // file doesn't exist — skip
      }
    })
  );
  return results.filter(Boolean);
}

async function readmeSnippet(cwd) {
  const candidates = ["README.md", "README", "readme.md", "README.txt"];
  for (const name of candidates) {
    try {
      const raw = await fs.readFile(path.join(cwd, name), "utf-8");
      const lines = raw.split("\n").slice(0, 80);
      return lines.join("\n");
    } catch {
      // try next
    }
  }
  return null;
}
