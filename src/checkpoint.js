/**
 * Git Checkpoint System — inspired by Kilocode and OpenCode.
 *
 * Creates lightweight snapshots before agent runs, allowing easy rollback
 * of all changes made during a session. Uses git stash for simplicity
 * and compatibility (no git internals like write-tree/read-tree).
 *
 * Design:
 *   - Before each agent run, capture a checkpoint of the working tree
 *   - Track which files were modified during the run
 *   - Provide /undo to revert all changes from the last run
 *   - Checkpoints are stored as git stash entries with a marker message
 *
 * Safety:
 *   - Only operates within git repositories
 *   - Uses `git stash` (standard, safe operation)
 *   - Preserves untracked files in checkpoints
 *   - Warns before destructive rollback
 */

import { execFileSync } from "node:child_process";
import { logger } from "./logger.js";

const TIMEOUT_MS = 15_000;
const CHECKPOINT_PREFIX = "smol-agent-checkpoint:";

/**
 * Check if the directory is inside a git repository.
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
 * Get a list of currently modified/untracked files.
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
 * Create a checkpoint of the current working tree state.
 *
 * @param {string} cwd - Working directory
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

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const stashMsg = `${CHECKPOINT_PREFIX}${timestamp}${label ? " " + label : ""}`;

  try {
    // Stage everything first so stash captures all changes
    execFileSync("git", ["add", "--all"], {
      cwd, encoding: "utf-8", timeout: TIMEOUT_MS,
      stdio: ["pipe", "pipe", "pipe"],
    });

    // Create stash entry
    execFileSync("git", ["stash", "push", "-m", stashMsg], {
      cwd, encoding: "utf-8", timeout: TIMEOUT_MS,
      stdio: ["pipe", "pipe", "pipe"],
    });

    // Immediately restore the working tree (stash entry remains in the list)
    execFileSync("git", ["stash", "apply"], {
      cwd, encoding: "utf-8", timeout: TIMEOUT_MS,
      stdio: ["pipe", "pipe", "pipe"],
    });

    logger.info(`Checkpoint created: ${stashMsg} (${changes.length} files)`);
    return { created: true, message: stashMsg, files: changes.length };
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
 * @returns {Array<{ index: number, message: string, date: string }>}
 */
export function listCheckpoints(cwd, limit = 10) {
  if (!isGitRepo(cwd)) return [];

  try {
    const output = execFileSync("git", ["stash", "list"], {
      cwd, encoding: "utf-8", timeout: TIMEOUT_MS,
      stdio: ["pipe", "pipe", "pipe"],
    });

    if (!output.trim()) return [];

    return output.trim().split("\n")
      .filter(line => line.includes(CHECKPOINT_PREFIX))
      .slice(0, limit)
      .map(line => {
        const match = line.match(/^stash@\{(\d+)\}: .*?: (.+)$/);
        if (!match) return null;
        return { index: parseInt(match[1], 10), message: match[2] };
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Rollback to a checkpoint, discarding all changes made since.
 *
 * This is a DESTRUCTIVE operation — it will:
 *   1. Discard all current working tree changes
 *   2. Apply the checkpoint's saved state
 *
 * @param {string} cwd - Working directory
 * @param {number} [stashIndex] - Stash index to restore (default: most recent checkpoint)
 * @returns {{ restored: boolean, message?: string, error?: string }}
 */
export function rollbackToCheckpoint(cwd, stashIndex = null) {
  if (!isGitRepo(cwd)) {
    return { restored: false, error: "Not a git repository" };
  }

  const checkpoints = listCheckpoints(cwd, 1);
  if (checkpoints.length === 0) {
    return { restored: false, error: "No checkpoints found" };
  }

  const target = stashIndex !== null
    ? stashIndex
    : checkpoints[0].index;

  try {
    // First, discard current working tree changes
    execFileSync("git", ["checkout", "--", "."], {
      cwd, encoding: "utf-8", timeout: TIMEOUT_MS,
      stdio: ["pipe", "pipe", "pipe"],
    });

    // Remove any untracked files that were added
    execFileSync("git", ["clean", "-fd"], {
      cwd, encoding: "utf-8", timeout: TIMEOUT_MS,
      stdio: ["pipe", "pipe", "pipe"],
    });

    // Apply the stashed checkpoint
    execFileSync("git", ["stash", "apply", `stash@{${target}}`], {
      cwd, encoding: "utf-8", timeout: TIMEOUT_MS,
      stdio: ["pipe", "pipe", "pipe"],
    });

    logger.info(`Rolled back to checkpoint stash@{${target}}`);
    return { restored: true, message: `Restored to checkpoint: ${checkpoints[0]?.message || `stash@{${target}}`}` };
  } catch (err) {
    logger.warn(`Rollback failed: ${err.message}`);
    return { restored: false, error: err.message };
  }
}

/**
 * Clean up old checkpoints (keep only the most recent N).
 *
 * @param {string} cwd - Working directory
 * @param {number} [keep=3] - Number of checkpoints to keep
 */
export function cleanupCheckpoints(cwd, keep = 3) {
  const checkpoints = listCheckpoints(cwd, 100);
  if (checkpoints.length <= keep) return;

  // Drop oldest checkpoints (higher indices = older in stash)
  const toDrop = checkpoints.slice(keep);
  // Drop from highest index first to avoid index shifting
  for (const cp of toDrop.reverse()) {
    try {
      execFileSync("git", ["stash", "drop", `stash@{${cp.index}}`], {
        cwd, encoding: "utf-8", timeout: TIMEOUT_MS,
        stdio: ["pipe", "pipe", "pipe"],
      });
      logger.debug(`Cleaned up old checkpoint: stash@{${cp.index}}`);
    } catch {
      // Ignore errors — index may have shifted
    }
  }
}
