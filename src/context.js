import fs from "node:fs/promises";
import path from "node:path";
import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

/**
 * Gather project context to inject into the system prompt so the model
 * starts every conversation with awareness of the working environment.
 */
export async function gatherContext(cwd) {
  // Run all independent context-gathering tasks in parallel
  const [skills, tree, git, configs, readme] = await Promise.all([
    loadSkills(cwd),
    fileTree(cwd, 2),
    gitInfo(cwd),
    readConfigs(cwd, [
      "package.json",
      "tsconfig.json",
      "pyproject.toml",
      "Cargo.toml",
      "go.mod",
      "Makefile",
      ".env.example",
    ]),
    readmeSnippet(cwd),
  ]);

  const sections = [];

  // 1. Working directory
  sections.push(`## Working directory\n${cwd}`);

  // 2. Agent skills — project-specific instructions that extend agent behavior.
  //    Placed first so the model prioritizes them.
  if (skills.length > 0) {
    sections.push(`## Agent skills\n${skills.join("\n\n---\n\n")}`);
  }

  // 3. File tree (top 2 levels, ignore noise)
  if (tree.length > 0) {
    sections.push(`## Project file tree\n${tree.join("\n")}`);
  }

  // 4. Git info
  if (git) {
    sections.push(`## Git status\n${git}`);
  }

  // 5. Key config files
  if (configs.length > 0) {
    sections.push(
      `## Project configuration files\n${configs.join("\n---\n")}`
    );
  }

  // 6. README snippet (first 80 lines)
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

async function gitInfo(cwd) {
  try {
    const [branchResult, statusResult, logResult] = await Promise.all([
      execAsync("git rev-parse --abbrev-ref HEAD", { cwd, timeout: 5000 }),
      execAsync("git status --short", { cwd, timeout: 5000 }),
      execAsync("git log --oneline -5", { cwd, timeout: 5000 }).catch(
        () => ({ stdout: "(no commits)" })
      ),
    ]);

    const branch = branchResult.stdout.trim();
    const status = statusResult.stdout.trim();
    const recentLog = logResult.stdout.trim() || "(no commits)";

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

/**
 * Load agent skills from .smol/skills/.
 * Each file in the directory is treated as one skill.
 * Files are read in alphabetical order and returned as formatted strings.
 */
async function loadSkills(cwd) {
  const skillsDir = path.join(cwd, ".smol", "skills");
  let entries;
  try {
    entries = await fs.readdir(skillsDir, { withFileTypes: true });
  } catch {
    return []; // directory doesn't exist — no skills
  }

  const files = entries
    .filter((e) => e.isFile())
    .map((e) => e.name)
    .sort();

  const results = await Promise.all(
    files.map(async (name) => {
      try {
        const content = await fs.readFile(path.join(skillsDir, name), "utf-8");
        const trimmed = content.trim();
        if (!trimmed) return null;
        // Use filename (without extension) as the skill heading
        const heading = name.replace(/\.[^.]+$/, "");
        return `### ${heading}\n${trimmed}`;
      } catch {
        return null;
      }
    })
  );

  return results.filter(Boolean);
}
