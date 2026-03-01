import fs from "node:fs/promises";
import path from "node:path";
import { execSync } from "node:child_process";
import { loadMemories } from "./tools/memory.js";

const IGNORED = new Set([
  "node_modules", ".git", "__pycache__", ".next", "dist", "build",
  "target", ".venv", "venv", "coverage", ".smol-agent",
]);

/**
 * Gather lightweight project context for the system prompt.
 *
 * Deliberately minimal — the agent has tools (read_file, list_files, grep)
 * to explore deeper on demand.  Keeping the system prompt small leaves more
 * context budget for the actual conversation.
 */
export async function gatherContext(cwd, contextSize = 100) {
  const sections = [];

  // 1. Working directory
  sections.push(`Working directory: ${cwd}`);

  // 2. Project type (one-liner detected from manifest files)
  const projectType = await detectProjectType(cwd);
  if (projectType) sections.push(`Project: ${projectType}`);

  // 3. Brief file tree (top-level + one level into subdirs)
  const tree = await topLevelTree(cwd);
  if (tree.length > 0) sections.push(`Files:\n${tree.join("\n")}`);

  // 4. Git branch + uncommitted changes
  const git = gitInfo(cwd);
  if (git) sections.push(git);

  // 5. AGENT.md — user-provided instructions for the agent
  const agentMd = await readSnippet(cwd, "AGENT.md", contextSize);
  if (agentMd) sections.push(`## AGENT.md\n${agentMd}`);

  // 6. Persistent memories from previous sessions
  try {
    const memories = await loadMemories(cwd);
    const keys = Object.keys(memories);
    if (keys.length > 0) {
      const memLines = keys.slice(0, 20).map(k => {
        const m = memories[k];
        return `- **${k}** (${m.category || "general"}): ${m.value}`;
      });
      const suffix = keys.length > 20 ? `\n- ... and ${keys.length - 20} more (use recall tool)` : "";
      sections.push(`## Memories from previous sessions\n${memLines.join("\n")}${suffix}`);
    }
  } catch { /* no memories */ }

  return sections.join("\n\n");
}

// ── helpers ──────────────────────────────────────────────────────────

async function detectProjectType(cwd) {
  const checks = [
    ["package.json", "Node.js"],
    ["pyproject.toml", "Python"],
    ["Cargo.toml", "Rust"],
    ["go.mod", "Go"],
    ["pom.xml", "Java (Maven)"],
    ["build.gradle", "Java (Gradle)"],
    ["Gemfile", "Ruby"],
    ["composer.json", "PHP"],
    ["CMakeLists.txt", "C/C++ (CMake)"],
    ["Makefile", "Make"],
  ];
  for (const [file, label] of checks) {
    try {
      await fs.access(path.join(cwd, file));
      return label;
    } catch { /* not found */ }
  }
  return null;
}

async function topLevelTree(cwd) {
  const entries = [];
  try {
    const items = await fs.readdir(cwd, { withFileTypes: true });
    items.sort((a, b) => a.name.localeCompare(b.name));
    for (const item of items) {
      if (IGNORED.has(item.name) || item.name.startsWith(".")) continue;
      if (item.isDirectory()) {
        entries.push(`${item.name}/`);
        try {
          const sub = await fs.readdir(path.join(cwd, item.name), {
            withFileTypes: true,
          });
          sub.sort((a, b) => a.name.localeCompare(b.name));
          for (const s of sub.slice(0, 20)) {
            if (IGNORED.has(s.name)) continue;
            entries.push(`  ${s.isDirectory() ? s.name + "/" : s.name}`);
          }
          if (sub.length > 20)
            entries.push(`  ... (${sub.length - 20} more)`);
        } catch { /* can't read subdir */ }
      } else {
        entries.push(item.name);
      }
    }
  } catch { /* can't read cwd */ }
  return entries;
}

function gitInfo(cwd) {
  try {
    const branch = execSync("git rev-parse --abbrev-ref HEAD", {
      cwd, encoding: "utf-8", timeout: 5000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();

    const status = execSync("git status --short", {
      cwd, encoding: "utf-8", timeout: 5000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();

    let out = `Git branch: ${branch}`;
    if (status) {
      const lines = status.split("\n");
      out += `\nUncommitted changes (${lines.length} file${lines.length !== 1 ? "s" : ""}):\n${status}`;
    }
    return out;
  } catch {
    return null;
  }
}

async function readSnippet(cwd, filename, maxLines) {
  try {
    const raw = await fs.readFile(path.join(cwd, filename), "utf-8");
    return raw.split("\n").slice(0, maxLines).join("\n");
  } catch {
    return null;
  }
}
