/**
 * Git Checkpoint System — inspired by Kilocode and OpenCode.
 *
 * Creates lightweight snapshots before agent runs, allowing easy rollback
 * of all changes made during a session. Uses a secondary git repo inside
 * .smol-agent/checkpoints/ to avoid polluting the main repo's stash or
 * history.
 *
 * Design:
 *   - A shadow git repo at .smol-agent/checkpoints/ mirrors the working tree
 *   - Before each agent run, copy tracked + untracked files into the shadow
 *     repo and commit them as a checkpoint
 *   - On /undo, restore files from the shadow repo's commit back to the
 *     working tree
 *   - Completely isolated from the user's main git workflow
 *
 * Safety:
 *   - Never touches the main repo's git state (no stash, no staging changes)
 *   - Only copies files; does not modify .git/ in the main repo
 *   - Preserves untracked files in checkpoints
 *   - Warns before destructive rollback
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { logger } from "./logger.js";

const TIMEOUT_MS = 15_000;
const CHECKPOINT_DIR = ".smol-agent/checkpoints";
const CHECKPOINT_PREFIX = "smol-agent-checkpoint:";

/**
 * Get the path to the shadow checkpoint repo.
 */
function checkpointRepoPath(cwd) {
  return path.join(cwd, CHECKPOINT_DIR);
}

/**
 * Initialize the shadow checkpoint repo if it doesn't exist.
 */
function ensureCheckpointRepo(cwd) {
  const repoPath = checkpointRepoPath(cwd);

  if (!fs.existsSync(path.join(repoPath, ".git"))) {
    fs.mkdirSync(repoPath, { recursive: true });
    execFileSync("git", ["init"], {
      cwd: repoPath, encoding: "utf-8", timeout: TIMEOUT_MS,
      stdio: ["pipe", "pipe", "pipe"],
    });
    execFileSync("git", ["config", "user.email", "smol-agent@checkpoint"], {
      cwd: repoPath, encoding: "utf-8", timeout: TIMEOUT_MS,
      stdio: ["pipe", "pipe", "pipe"],
    });
    execFileSync("git", ["config", "user.name", "smol-agent"], {
      cwd: repoPath, encoding: "utf-8", timeout: TIMEOUT_MS,
      stdio: ["pipe", "pipe", "pipe"],
    });
    execFileSync("git", ["config", "commit.gpgsign", "false"], {
      cwd: repoPath, encoding: "utf-8", timeout: TIMEOUT_MS,
      stdio: ["pipe", "pipe", "pipe"],
    });
    logger.debug("Checkpoint repo initialized at " + repoPath);
  }

  return repoPath;
}

/**
 * Check if the main directory is inside a git repository.
 */
function isGitRepo(cwd) {
  try {
    execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd, encoding: "utf-8", timeout: TIMEOUT_MS,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Get list of files to checkpoint (tracked + untracked, excluding .smol-agent/).
 * Uses git ls-files for tracked and git ls-files --others for untracked.
 */
function getFilesToCheckpoint(cwd) {
  try {
    // Tracked files (including modified)
    const tracked = execFileSync(
      "git", ["ls-files", "--full-name"],
      { cwd, encoding: "utf-8", timeout: TIMEOUT_MS, stdio: ["pipe", "pipe", "pipe"] }
    ).trim().split("\n").filter(Boolean);

    // Untracked files (excluding ignored)
    const untracked = execFileSync(
      "git", ["ls-files", "--others", "--exclude-standard", "--full-name"],
      { cwd, encoding: "utf-8", timeout: TIMEOUT_MS, stdio: ["pipe", "pipe", "pipe"] }
    ).trim().split("\n").filter(Boolean);

    const all = [...new Set([...tracked, ...untracked])];

    // Exclude .smol-agent/ directory
    return all.filter(f => !f.startsWith(".smol-agent/") && !f.startsWith(".smol-agent\\"));
  } catch {
    return [];
  }
}

/**
 * Get a list of currently modified/untracked files in the main repo.
 */
function getWorkingTreeChanges(cwd) {
  try {
    const output = execFileSync("git", ["status", "--porcelain"], {
      cwd, encoding: "utf-8", timeout: TIMEOUT_MS,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return output.trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Sync files from the main working tree to the shadow checkpoint repo.
 */
function syncToCheckpointRepo(cwd, repoPath) {
  const files = getFilesToCheckpoint(cwd);

  // Clean the checkpoint repo (except .git)
  const entries = fs.readdirSync(repoPath);
  for (const entry of entries) {
    if (entry === ".git") continue;
    const fullPath = path.join(repoPath, entry);
    fs.rmSync(fullPath, { recursive: true, force: true });
  }

  // Copy files from main working tree to checkpoint repo
  let copied = 0;
  for (const relFile of files) {
    const src = path.join(cwd, relFile);
    const dest = path.join(repoPath, relFile);

    try {
      // Skip if source doesn't exist (deleted file in status)
      if (!fs.existsSync(src)) continue;

      const stat = fs.statSync(src);
      if (stat.isDirectory()) continue;

      // Skip large files (> 1MB)
      if (stat.size > 1_000_000) continue;

      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(src, dest);
      copied++;
    } catch {
      // Skip files that can't be copied (binary, permission issues, etc.)
    }
  }

  return copied;
}

/**
 * Create a checkpoint of the current working tree state.
 *
 * @param {string} cwd - Working directory (must be a git repo)
 * @param {string} [label] - Optional label for the checkpoint
 * @returns {{ created: boolean, message?: string, error?: string }}
 */
export function createCheckpoint(cwd, label = "") {
  if (!isGitRepo(cwd)) {
    return { created: false, error: "Not a git repository" };
  }

  const changes = getWorkingTreeChanges(cwd);
  if (changes.length === 0) {
    logger.debug("Checkpoint: no changes to checkpoint");
    return { created: false, message: "No changes to checkpoint (clean working tree)" };
  }

  try {
    const repoPath = ensureCheckpointRepo(cwd);
    const copied = syncToCheckpointRepo(cwd, repoPath);

    if (copied === 0) {
      return { created: false, message: "No files to checkpoint" };
    }

    // Stage everything in the checkpoint repo
    execFileSync("git", ["add", "--all"], {
      cwd: repoPath, encoding: "utf-8", timeout: TIMEOUT_MS,
      stdio: ["pipe", "pipe", "pipe"],
    });

    // Check if there's anything to commit
    const status = execFileSync("git", ["status", "--porcelain"], {
      cwd: repoPath, encoding: "utf-8", timeout: TIMEOUT_MS,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();

    if (!status) {
      return { created: false, message: "No changes to checkpoint (identical to last checkpoint)" };
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const commitMsg = `${CHECKPOINT_PREFIX}${timestamp}${label ? " " + label : ""}`;

    execFileSync("git", ["commit", "-m", commitMsg], {
      cwd: repoPath, encoding: "utf-8", timeout: TIMEOUT_MS,
      stdio: ["pipe", "pipe", "pipe"],
    });

    logger.info(`Checkpoint created: ${commitMsg} (${changes.length} changed files, ${copied} total files)`);
    return { created: true, message: commitMsg, files: changes.length };
  } catch (err) {
    logger.warn(`Checkpoint creation failed: ${err.message}`);
    return { created: false, error: err.message };
  }
}

/**
 * List recent checkpoints.
 *
 * @param {string} cwd - Working directory
 * @param {number} [limit=10] - Max checkpoints to return
 * @returns {Array<{ hash: string, message: string }>}
 */
export function listCheckpoints(cwd, limit = 10) {
  const repoPath = checkpointRepoPath(cwd);
  if (!fs.existsSync(path.join(repoPath, ".git"))) return [];

  try {
    const output = execFileSync(
      "git", ["log", "--oneline", "--format=%H %s", `-${limit * 2}`],
      { cwd: repoPath, encoding: "utf-8", timeout: TIMEOUT_MS, stdio: ["pipe", "pipe", "pipe"] }
    );

    if (!output.trim()) return [];

    return output.trim().split("\n")
      .filter(line => line.includes(CHECKPOINT_PREFIX))
      .slice(0, limit)
      .map(line => {
        const spaceIdx = line.indexOf(" ");
        const hash = line.slice(0, spaceIdx);
        const message = line.slice(spaceIdx + 1);
        return { hash, message };
      });
  } catch {
    return [];
  }
}

/**
 * Rollback to a checkpoint, restoring the working tree to that state.
 *
 * This is a DESTRUCTIVE operation — it will:
 *   1. Discard all current working tree changes
 *   2. Restore files from the checkpoint commit
 *
 * @param {string} cwd - Working directory
 * @param {string} [commitHash] - Specific commit hash to restore (default: most recent checkpoint)
 * @returns {{ restored: boolean, message?: string, error?: string }}
 */
export function rollbackToCheckpoint(cwd, commitHash = null) {
  if (!isGitRepo(cwd)) {
    return { restored: false, error: "Not a git repository" };
  }

  const checkpoints = listCheckpoints(cwd, 1);
  if (checkpoints.length === 0) {
    return { restored: false, error: "No checkpoints found" };
  }

  const target = commitHash || checkpoints[0].hash;
  const repoPath = checkpointRepoPath(cwd);

  try {
    // Get the list of files from the checkpoint commit
    const filesInCheckpoint = execFileSync(
      "git", ["ls-tree", "-r", "--name-only", target],
      { cwd: repoPath, encoding: "utf-8", timeout: TIMEOUT_MS, stdio: ["pipe", "pipe", "pipe"] }
    ).trim().split("\n").filter(Boolean);

    // First, revert tracked files in the main repo to HEAD
    execFileSync("git", ["checkout", "--", "."], {
      cwd, encoding: "utf-8", timeout: TIMEOUT_MS,
      stdio: ["pipe", "pipe", "pipe"],
    });

    // Remove untracked files added since checkpoint (but preserve .smol-agent/)
    execFileSync("git", ["clean", "-fd", "-e", ".smol-agent/"], {
      cwd, encoding: "utf-8", timeout: TIMEOUT_MS,
      stdio: ["pipe", "pipe", "pipe"],
    });

    // Checkout the checkpoint commit in the shadow repo (detached HEAD)
    execFileSync("git", ["checkout", target], {
      cwd: repoPath, encoding: "utf-8", timeout: TIMEOUT_MS,
      stdio: ["pipe", "pipe", "pipe"],
    });

    // Copy files back from checkpoint repo to working tree
    let restored = 0;
    for (const relFile of filesInCheckpoint) {
      const src = path.join(repoPath, relFile);
      const dest = path.join(cwd, relFile);

      try {
        if (!fs.existsSync(src)) continue;
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(src, dest);
        restored++;
      } catch {
        // Skip files that can't be restored
      }
    }

    // Return shadow repo to the latest branch
    try {
      execFileSync("git", ["checkout", "-"], {
        cwd: repoPath, encoding: "utf-8", timeout: TIMEOUT_MS,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch {
      // May fail if detached HEAD scenario, try master/main
      try {
        execFileSync("git", ["checkout", "master"], {
          cwd: repoPath, encoding: "utf-8", timeout: TIMEOUT_MS,
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch {
        // Best effort
      }
    }

    logger.info(`Rolled back to checkpoint ${target.slice(0, 8)} (${restored} files restored)`);
    return {
      restored: true,
      message: `Restored to checkpoint: ${checkpoints[0]?.message || target.slice(0, 8)}`,
      filesRestored: restored,
    };
  } catch (err) {
    logger.warn(`Rollback failed: ${err.message}`);
    return { restored: false, error: err.message };
  }
}

/**
 * Clean up old checkpoints. Runs git gc to compact the shadow repo.
 *
 * @param {string} cwd - Working directory
 * @param {number} [keep=5] - Number of checkpoints to keep (unused, kept for API compat)
 */
export function cleanupCheckpoints(cwd, _keep = 5) {
  const repoPath = checkpointRepoPath(cwd);
  if (!fs.existsSync(path.join(repoPath, ".git"))) return;

  try {
    execFileSync("git", ["gc", "--quiet"], {
      cwd: repoPath, encoding: "utf-8", timeout: TIMEOUT_MS,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch {
    // gc is best-effort
  }
}
