/**
 * Directory Watcher — Process files on change.
 * @file-doc
 *
 * Watches a directory for new or updated files and processes each change with
 * a headless agent using a provided prompt. Used by the `--watch` CLI flag.
 *
 * Architecture:
 * - `fs.watch` (recursive) drives change detection, with a slower poll loop as a
 *   fallback for platforms/filesystems where recursive events are unreliable.
 * - Changes are debounced per file, then processed through a single sequential
 *   queue — at most one agent runs at a time, keeping behavior predictable.
 * - A content-hash baseline prevents a runaway loop: the agent edits files in the
 *   watched tree, which would otherwise re-trigger the watcher forever. After each
 *   run we re-snapshot the tree, so the agent's own writes are absorbed into the
 *   baseline and never re-processed. Only changes made *after* a run completes by
 *   an external actor trigger new work. (Trade-off: an external edit that lands
 *   while an agent is mid-run may be absorbed into the new baseline and missed.)
 *
 * Dependencies:
 * - node:fs, node:path, node:crypto, node:child_process, node:url
 * - ./logger.js — Logging
 *
 * Depended on by:
 * - src/index.ts — CLI `--watch` flag integration
 *
 * @module watcher
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { logger } from "./logger.js";

/** Arguments passed to the agent runner for a single changed file. */
export interface RunAgentArgs {
  prompt: string;
  directory: string;
  provider?: string;
  model?: string;
  apiKey?: string;
  /** When true, spawn the child with command/code execution disabled (--no-exec). */
  noExec?: boolean;
}

export interface WatchOptions {
  /** Directory to watch (recursively). */
  watchPath: string;
  /** Prompt template applied to each changed file. */
  prompt: string;
  provider?: string;
  model?: string;
  apiKey?: string;
  /** Working directory / jail boundary for spawned agents. Defaults to watchPath. */
  jailDirectory?: string;
  /** Abort signal; aborting stops the watcher. */
  signal?: AbortSignal;
  /**
   * Allow spawned children to run commands / code. Default false: children run
   * with --no-exec so prompt-injection in an attacker-controlled changed file
   * can edit files but cannot execute commands unattended.
   */
  allowExec?: boolean;
  /** File extensions to watch (e.g. ['.js', '.ts']). Defaults to a broad set. */
  extensions?: string[];
  /** Directory/glob patterns to exclude. Merged with sensible defaults. */
  exclude?: string[];
  /** Callbacks (primarily for tests / embedding). */
  onFileDetected?: (filePath: string, eventType: string) => void;
  onAgentStart?: (filePath: string) => void;
  onAgentComplete?: (filePath: string, error: Error | null, result?: string) => void;
  /** Injectable agent runner; defaults to spawning a headless child process. */
  runAgent?: (args: RunAgentArgs) => Promise<string>;
  /** Tuning knobs (mostly for tests). */
  debounceMs?: number;
  pollIntervalMs?: number;
  /** Max bytes of file content embedded into the prompt before truncation. */
  maxEmbedBytes?: number;
}

export interface Watcher {
  stop: () => void;
}

const DEFAULT_EXTENSIONS = [
  ".js", ".ts", ".jsx", ".tsx", ".mjs", ".cjs", ".py", ".go", ".rs", ".java",
  ".c", ".cpp", ".h", ".hpp", ".cs", ".rb", ".php", ".swift", ".kt", ".scala",
  ".md", ".txt", ".json", ".yaml", ".yml", ".toml", ".xml",
  ".html", ".css", ".scss", ".sql", ".sh", ".bash",
];

const DEFAULT_EXCLUDE = ["node_modules", ".git", "dist", "build", ".smol-agent"];

const GLOB_EXCLUDE = ["*.min.js", "*.bundle.js", "package-lock.json", "yarn.lock", "pnpm-lock.yaml"];

/** Hard cap on a single spawned agent run; a wedged child must not stall the queue. */
const AGENT_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Watch a directory for file changes and process each change with an agent.
 *
 * Returns a handle with a `stop()` method. The watcher also stops when the
 * provided `signal` aborts.
 */
export function watchDirectory(options: WatchOptions): Watcher {
  const {
    watchPath,
    prompt,
    provider,
    model,
    apiKey,
    jailDirectory,
    signal,
    allowExec = false,
    onFileDetected,
    onAgentStart,
    onAgentComplete,
    extensions,
    exclude = [],
    runAgent = spawnAgent,
    debounceMs = 300,
    pollIntervalMs = 1000,
    // The default spawnAgent passes the whole prompt as a single argv string, and
    // Linux caps one argv entry at ~128KB (MAX_ARG_STRLEN). Keep the embedded slice
    // well under that so a large changed file can't make the child fail to spawn.
    maxEmbedBytes = 32 * 1024,
  } = options;

  const absolutePath = path.resolve(watchPath);
  const watchExtensions = extensions ?? DEFAULT_EXTENSIONS;
  const dirExcludes = [...DEFAULT_EXCLUDE, ...exclude];
  const globExcludes = [...GLOB_EXCLUDE];

  // ── Loop-prevention state ───────────────────────────────────────────────
  // baseline[file] = content hash as of the last time we observed/processed it.
  // A change matching the baseline is a no-op (or the agent's own write echo).
  const baseline = new Map<string, string>();
  // Cheap mtime cache so the poll loop only hashes files that may have changed.
  const mtimeCache = new Map<string, number>();
  const debounceTimers = new Map<string, NodeJS.Timeout>();
  const queue: string[] = [];
  const queued = new Set<string>();
  let draining = false;
  let stopped = false;

  function shouldProcess(filePath: string): boolean {
    const relativePath = path.relative(absolutePath, filePath);
    // Outside the watched tree (e.g. ".." escapes) — ignore.
    if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) return false;

    if (!watchExtensions.includes(path.extname(filePath))) return false;

    const segments = relativePath.split(/[/\\]/);
    if (segments.some((seg) => dirExcludes.includes(seg))) return false;

    const base = path.basename(filePath);
    for (const pattern of globExcludes) {
      if (pattern.startsWith("*")) {
        if (base.endsWith(pattern.slice(1))) return false;
      } else if (base === pattern) {
        return false;
      }
    }
    return true;
  }

  function hashFile(filePath: string): string | null {
    try {
      const buf = fs.readFileSync(filePath);
      return crypto.createHash("sha1").update(buf).digest("hex");
    } catch {
      return null; // deleted or unreadable mid-flight
    }
  }

  /** Walk the tree and (re)record baseline hashes + mtimes for processable files. */
  function snapshotBaseline(): void {
    // Rebuild from scratch each pass so deleted files drop out of the baseline and
    // the maps don't grow unbounded across the lifetime of a long-running watcher.
    baseline.clear();
    mtimeCache.clear();
    const walk = (dir: string): void => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (dirExcludes.includes(entry.name)) continue;
          walk(fullPath);
        } else if (entry.isFile() && shouldProcess(fullPath)) {
          const hash = hashFile(fullPath);
          if (hash !== null) baseline.set(fullPath, hash);
          try {
            mtimeCache.set(fullPath, fs.statSync(fullPath).mtimeMs);
          } catch {
            /* ignore */
          }
        }
      }
    };
    walk(absolutePath);
  }

  function scheduleEnqueue(filePath: string): void {
    const existing = debounceTimers.get(filePath);
    if (existing) clearTimeout(existing);
    debounceTimers.set(
      filePath,
      setTimeout(() => {
        debounceTimers.delete(filePath);
        enqueue(filePath);
      }, debounceMs),
    );
  }

  function enqueue(filePath: string): void {
    if (stopped) return;
    if (!shouldProcess(filePath)) return;
    if (queued.has(filePath)) return;

    // Skip symlinks: a link inside the watched tree can resolve to a file outside
    // it (its own relative path passes shouldProcess, but reading it follows the
    // link). Refusing to process links keeps the agent confined to the real tree.
    try {
      if (fs.lstatSync(filePath).isSymbolicLink()) return;
    } catch {
      return; // gone
    }

    let stat: fs.Stats;
    try {
      stat = fs.statSync(filePath);
    } catch {
      return; // gone
    }
    if (!stat.isFile()) return;
    mtimeCache.set(filePath, stat.mtimeMs);

    const hash = hashFile(filePath);
    if (hash === null) return;
    if (baseline.get(filePath) === hash) return; // unchanged vs baseline — skip

    queued.add(filePath);
    queue.push(filePath);
    void drain();
  }

  async function drain(): Promise<void> {
    if (draining) return;
    draining = true;
    try {
      while (queue.length > 0 && !stopped) {
        const filePath = queue.shift()!;
        queued.delete(filePath);

        // Re-check against the latest baseline: a prior run may have re-snapshotted
        // and absorbed this file's content (e.g. it was the agent's own write).
        const hash = hashFile(filePath);
        if (hash === null) continue;
        if (baseline.get(filePath) === hash) continue;

        await processFile(filePath, hash);
      }
    } finally {
      draining = false;
    }
  }

  async function processFile(filePath: string, hash: string): Promise<void> {
    const relativePath = path.relative(absolutePath, filePath);
    let content: string;
    try {
      content = fs.readFileSync(filePath, "utf-8");
    } catch {
      return;
    }

    // Record the triggering content as baseline up front so re-reads during the
    // run don't re-enqueue the same revision.
    baseline.set(filePath, hash);

    const sizeBytes = Buffer.byteLength(content, "utf-8");
    const lines = content.split("\n").length;
    onFileDetected?.(filePath, "change");
    console.log(`\n${"─".repeat(60)}`);
    console.log(`📄 Changed: ${relativePath}`);
    console.log(`   ${lines} lines · ${(sizeBytes / 1024).toFixed(1)} KB`);
    console.log(`${"─".repeat(60)}`);

    let embedded = content;
    if (sizeBytes > maxEmbedBytes) {
      // Truncate on a byte boundary — content.slice() counts UTF-16 code units, so
      // it would keep more than maxEmbedBytes worth of bytes for multi-byte text.
      embedded = Buffer.from(content, "utf-8").subarray(0, maxEmbedBytes).toString("utf-8") + `\n\n... [truncated — ${sizeBytes} bytes total]`;
    }

    const promptWithFile = `${prompt}

---

**File Changed**: \`${relativePath}\`

\`\`\`
${embedded}
\`\`\`

---

Process the above file according to the instructions.`;

    try {
      onAgentStart?.(filePath);
      console.log(`🤖 Starting agent...\n`);
      const result = await runAgent({
        prompt: promptWithFile,
        directory: jailDirectory || absolutePath,
        provider,
        model,
        apiKey,
        noExec: !allowExec,
      });
      onAgentComplete?.(filePath, null, result);
      console.log(`\n${"─".repeat(60)}`);
      console.log(`✅ Done: ${relativePath}`);
      console.log(`${"─".repeat(60)}`);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      logger.error(`Failed to process ${filePath}: ${error.message}`);
      onAgentComplete?.(filePath, error);
      console.error(`${"─".repeat(60)}`);
      console.error(`❌ Error: ${relativePath}`);
      console.error(`   ${error.message}`);
      console.error(`${"─".repeat(60)}`);
    } finally {
      // Re-snapshot the whole tree so any files the agent created/edited (this one
      // or others) become the new baseline and won't re-trigger processing.
      snapshotBaseline();
    }
  }

  // ── Startup ─────────────────────────────────────────────────────────────
  logger.info(`Watching directory: ${absolutePath}`);
  console.log(`\n${"═".repeat(60)}`);
  console.log(`👀 Watching directory for changes`);
  console.log(`${"═".repeat(60)}`);
  console.log(`📁 Path:       ${absolutePath}`);
  console.log(`📝 Prompt:     ${prompt}`);
  console.log(`📂 Extensions: ${watchExtensions.join(", ")}`);
  console.log(`🚫 Excluding:  ${[...dirExcludes, ...globExcludes].join(", ")}`);
  console.log(`⚙️  Exec:       ${allowExec ? "ENABLED (--watch-allow-exec)" : "disabled (--no-exec)"}`);
  console.log(`${"═".repeat(60)}`);
  if (allowExec) {
    console.log(`⚠️  DANGER: --watch-allow-exec lets the headless, auto-approved agent run`);
    console.log(`    commands (run_command/code_execution) on attacker-influenceable file`);
    console.log(`    content with no human review. Only use on fully trusted trees.`);
  } else {
    console.log(`ℹ️  Children run with --no-exec: they may edit files but cannot run`);
    console.log(`    commands, limiting prompt-injection from changed file content.`);
    console.log(`    Pass --watch-allow-exec to permit command execution (riskier).`);
  }
  console.log(`${"═".repeat(60)}`);
  console.log(`Press Ctrl+C to stop.\n`);

  // Seed baselines for existing files so only changes *after* startup are processed.
  snapshotBaseline();

  let watcher: fs.FSWatcher | null = null;
  try {
    watcher = fs.watch(absolutePath, { recursive: true }, (_eventType, filename) => {
      if (!filename || stopped) return;
      const filePath = path.join(absolutePath, filename.toString());
      scheduleEnqueue(filePath);
    });
    watcher.on("error", (err: Error) => {
      logger.error(`Watcher error: ${err.message}`);
      console.error(`\n❌ Watcher error: ${err.message}`);
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(`fs.watch unavailable (${msg}); relying on poll fallback.`);
  }

  // Poll fallback: detect changes fs.watch may miss. Only hashes files whose
  // mtime advanced, then routes them through the same baseline-deduped enqueue.
  const pollTimer = setInterval(() => {
    if (stopped) return;
    const walk = (dir: string): void => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (dirExcludes.includes(entry.name)) continue;
          walk(fullPath);
        } else if (entry.isFile() && shouldProcess(fullPath)) {
          let mtime: number;
          try {
            mtime = fs.statSync(fullPath).mtimeMs;
          } catch {
            continue;
          }
          if (mtime > (mtimeCache.get(fullPath) ?? 0)) {
            mtimeCache.set(fullPath, mtime);
            scheduleEnqueue(fullPath);
          }
        }
      }
    };
    walk(absolutePath);
  }, pollIntervalMs);
  // Don't keep the event loop alive solely for the poll timer.
  if (typeof pollTimer.unref === "function") pollTimer.unref();

  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    watcher?.close();
    clearInterval(pollTimer);
    for (const timer of debounceTimers.values()) clearTimeout(timer);
    debounceTimers.clear();
    console.log("\n\n👋 Stopped watching.");
  };

  signal?.addEventListener("abort", stop, { once: true });

  return { stop };
}

/**
 * Default agent runner: spawn a headless child agent process to handle a file.
 * Mirrors the spawn strategy used by cross-agent.js for consistency.
 */
function spawnAgent({ prompt, directory, provider, model, apiKey, noExec }: RunAgentArgs): Promise<string> {
  return new Promise((resolve, reject) => {
    const args = ["--directory", directory, "--auto-approve", "--headless"];
    // Default: deny command/code execution so prompt-injected file content can't
    // drive the unattended child into running arbitrary commands. Writes still work.
    if (noExec) args.push("--no-exec");
    if (provider) args.push("--provider", provider);
    if (model) args.push("--model", model);
    // API key is passed via env var (not argv) so it isn't visible in `ps` output.
    // (Note: env vars are still readable via /proc/<pid>/environ by the same user.)
    args.push(prompt);

    const localBin = path.join(path.dirname(fileURLToPath(import.meta.url)), "index.js");
    const command = fs.existsSync(localBin) ? "node" : "smol-agent";
    const spawnArgs = command === "node" ? [localBin, ...args] : args;

    const childEnv = { ...process.env };
    if (apiKey) childEnv.SMOL_AGENT_API_KEY = apiKey;

    logger.info(`Spawning agent for file in ${directory}`);

    const child = spawn(command, spawnArgs, {
      cwd: directory,
      env: childEnv,
      stdio: ["ignore", "inherit", "pipe"], // show agent output; capture stderr
    });

    // Guard against a wedged child blocking the single processing queue forever.
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      logger.warn(`Agent for ${directory} exceeded ${AGENT_TIMEOUT_MS}ms; killing it.`);
      child.kill("SIGTERM");
      // Escalate if it ignores SIGTERM.
      const killTimer = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* already gone */ } }, 5000);
      if (typeof killTimer.unref === "function") killTimer.unref();
      finish(() => reject(new Error(`Agent timed out after ${AGENT_TIMEOUT_MS}ms`)));
    }, AGENT_TIMEOUT_MS);
    if (typeof timer.unref === "function") timer.unref();
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    const MAX_STDERR = 8192;
    let stderr = "";
    child.stderr?.on("data", (data: Buffer) => {
      const text = data.toString();
      stderr += text;
      if (stderr.length > MAX_STDERR * 2) stderr = stderr.slice(-MAX_STDERR);
      for (const line of text.split("\n")) {
        if (line.trim()) console.log(`  │ ${line}`);
      }
    });

    child.on("error", (err: Error) => {
      finish(() => reject(new Error(`Failed to spawn agent: ${err.message}`)));
    });

    child.on("close", (code: number | null) => {
      finish(() => {
        if (code === 0) resolve("Completed");
        else reject(new Error(stderr.trim() || `Agent exited with code ${code}`));
      });
    });
  });
}
