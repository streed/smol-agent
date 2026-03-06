import {
  ProcessTerminal,
  TUI,
  Text,
  Container,
  Editor,
  Markdown,
  Spacer,
  CombinedAutocompleteProvider,
  matchesKey,
  truncateToWidth,
  visibleWidth,
} from "@mariozechner/pi-tui";
import chalk from "chalk";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { execSync, execFile } from "node:child_process";
import { setAskHandler } from "../tools/ask_user.js";
import { saveSetting } from "../settings.js";
import { listModels } from "../ollama.js";
import { logger, readRecentLogs } from "../logger.js";

// ═══ Loading animation (SMOL AGENT rain effect) ═══

const PIXEL_FONT = {
  S: [" ##", "#  ", " # ", "  #", "## "],
  M: ["#   #", "## ##", "# # #", "#   #", "#   #"],
  O: [" # ", "# #", "# #", "# #", " # "],
  L: ["#  ", "#  ", "#  ", "#  ", "###"],
  A: [" # ", "# #", "###", "# #", "# #"],
  G: [" ##", "#  ", "# #", "# #", " ##"],
  E: ["###", "#  ", "## ", "#  ", "###"],
  N: ["#  #", "## #", "# ##", "#  #", "#  #"],
  T: ["###", " # ", " # ", " # ", " # "],
  " ": ["  ", "  ", "  ", "  ", "  "],
};

function generateLoadingFrames() {
  const W = 52, H = 11, NUM_FRAMES = 60, NUM_DROPS = 28;

  const textPixels = new Set();
  let xOff = 0;
  for (const ch of "SMOL AGENT") {
    const g = PIXEL_FONT[ch];
    if (!g) { xOff += 2; continue; }
    for (let r = 0; r < g.length; r++)
      for (let c = 0; c < g[r].length; c++)
        if (g[r][c] === "#") textPixels.add(`${xOff + c},${r}`);
    xOff += g[0].length + 1;
  }
  const xShift = Math.floor((W - (xOff - 1)) / 2);
  const yShift = Math.floor((H - 5) / 2);
  const centered = new Set();
  for (const key of textPixels) {
    const [x, y] = key.split(",").map(Number);
    centered.add(`${x + xShift},${y + yShift}`);
  }

  const drops = [];
  for (let i = 0; i < NUM_DROPS; i++) {
    drops.push({
      col: Math.floor(Math.random() * W),
      row: Math.random() * H * 2 - H,
      speed: 0.25 + Math.random() * 0.75,
      len: 2 + Math.floor(Math.random() * 4),
    });
  }

  const trail = ["▓", "▒", "░", "·", " "];
  const frames = [];

  for (let f = 0; f < NUM_FRAMES; f++) {
    const buf = Array.from({ length: H }, () => new Array(W).fill(" "));

    for (const d of drops) {
      const head = Math.floor(d.row);
      for (let t = 0; t < d.len && t < trail.length; t++) {
        const r = head - t;
        if (r >= 0 && r < H && !centered.has(`${d.col},${r}`)) {
          buf[r][d.col] = trail[t];
        }
      }
      d.row += d.speed;
      if (d.row - d.len > H) {
        d.col = Math.floor(Math.random() * W);
        d.row = -Math.floor(Math.random() * 4);
        d.speed = 0.25 + Math.random() * 0.75;
        d.len = 2 + Math.floor(Math.random() * 4);
      }
    }

    for (const key of centered) {
      const [x, y] = key.split(",").map(Number);
      if (x >= 0 && x < W && y >= 0 && y < H) buf[y][x] = "█";
    }

    frames.push(buf.map((r) => r.join("").trimEnd()));
  }

  return frames;
}

const LOADING_FRAMES = generateLoadingFrames();

const LOADING_MESSAGES = [
  "Gathering project context...",
  "Mapping the codebase...",
  "Checking git status...",
  "Warming up the brain...",
  "Preparing tools...",
  "Almost ready...",
];

class LoadingAnimation {
  constructor(tui, modelName) {
    this.tui = tui;
    this.modelName = modelName;
    this.frame = 0;
    this.msgIdx = 0;
    this.frameCount = 0;
    this.intervalId = setInterval(() => {
      this.frame++;
      this.frameCount++;
      if (this.frameCount % 10 === 0) {
        this.msgIdx = (this.msgIdx + 1) % LOADING_MESSAGES.length;
      }
      this.tui.requestRender();
    }, 100);
  }

  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  invalidate() {}

  render(width) {
    const frameLines = LOADING_FRAMES[this.frame % LOADING_FRAMES.length];
    const headerText = chalk.dim(" ◉ smol-agent ") + chalk.magenta(`(${this.modelName})`);
    const msgText = chalk.dim(LOADING_MESSAGES[this.msgIdx]);
    return [
      truncateToWidth(headerText, width),
      "",
      ...frameLines.map((line) => truncateToWidth(chalk.cyan.bold(line), width)),
      "",
      truncateToWidth(msgText, width),
    ];
  }
}

// ═══ Themes ═══

const markdownTheme = {
  heading: (t) => chalk.blue.bold(t),
  link: (t) => chalk.blue.underline(t),
  linkUrl: (t) => chalk.dim(t),
  code: (t) => chalk.magenta(t),
  codeBlock: (t) => chalk.green(t),
  codeBlockBorder: (t) => chalk.dim(t),
  quote: (t) => chalk.italic(chalk.dim(t)),
  quoteBorder: (t) => chalk.magenta(t),
  hr: (t) => chalk.dim(t),
  listBullet: (t) => chalk.magenta(t),
  bold: (t) => chalk.bold(t),
  italic: (t) => chalk.italic(t),
  strikethrough: (t) => chalk.strikethrough(t),
  underline: (t) => chalk.underline(t),
};

const editorTheme = {
  borderColor: (t) => chalk.dim(t),
  selectList: {
    selectedPrefix: (t) => chalk.green.bold(t),
    selectedText: (t) => chalk.bold(t),
    description: (t) => chalk.dim(t),
    scrollInfo: (t) => chalk.dim(t),
    noMatch: (t) => chalk.dim(t),
  },
};

// ═══ FooterBar component ═══

class FooterBar {
  constructor(getState) {
    this.getState = getState;
  }

  invalidate() {}

  render(width) {
    const { modelName, tokenUsage, gitStats } = this.getState();
    return [buildContextBar(modelName, tokenUsage, gitStats, width)];
  }
}

// ═══ StatusArea component ═══

class StatusArea {
  constructor(getState, tui) {
    this.getState = getState;
    this.loaderFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
    this.loaderFrame = 0;
    this.intervalId = setInterval(() => {
      this.loaderFrame = (this.loaderFrame + 1) % this.loaderFrames.length;
      tui.requestRender();
    }, 80);
  }

  stopAnimation() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  invalidate() {}

  render(width) {
    const state = this.getState();
    const lines = [];

    if (state.streamContent) {
      const sLines = state.streamContent.split("\n");
      lines.push("");
      const cursor = chalk.cyan("▌");
      
      // Check if the first line contains markdown formatting (e.g., **bold**, *italic*)
      const hasMarkdown = sLines[0].match(/\*\*.*?\*/s) !== null || sLines[0].match(/\*\.?.*?\*/s) !== null || sLines[0].match(/\*\[.*?\]\*/s) !== null;
      
      if (hasMarkdown) {
        // Render the first line as markdown — must spread rendered strings,
        // not push the Markdown component itself (pi-tui expects strings).
        const md = new Markdown(sLines[0], 1, 0, markdownTheme);
        lines.push(...md.render(width));
      } else {
        // Render as plain text
        const firstLine = chalk.cyan.bold(" ▸  ") + sLines[0] + (sLines.length === 1 ? cursor : "");
        lines.push(truncateToWidth(firstLine, width));
      }
      
      if (sLines.length > 1) {
        const lastLine = sLines[sLines.length - 1];
        lines.push(truncateToWidth("     " + lastLine + cursor, width));
      }
    } else if (state.busy) {
      const frame = this.loaderFrames[this.loaderFrame];
      lines.push("");
      const spinnerLine = " " + chalk.cyan(frame) + chalk.dim(` ${state.statusText || "thinking..."}`);
      lines.push(truncateToWidth(spinnerLine, width));
    }

    if (state.askState) {
      lines.push(truncateToWidth(
        chalk.magenta.bold(" ?  ") + chalk.bold(state.askState.question),
        width,
      ));
    }

    if (state.approvalState) {
      const { name, args } = state.approvalState;
      const summary = summarizeArgs(args);
      const shortSummary = summary.length > 60 ? summary.slice(0, 57) + "..." : summary;
      const approvalLine = chalk.yellow.bold(" ⚠  ") +
        chalk.bold(`Approve ${name}(${shortSummary})`) +
        chalk.dim(" [y/n/a]");
      lines.push(truncateToWidth(approvalLine, width));
    }

    return lines;
  }
}

// ═══ ChatView ═══
// Layout component that owns output, status, editor, and footer.
// Implements Focusable so TUI delegates input to it.
// Output grows naturally — pi-tui's viewport tracking keeps the bottom visible.

class ChatView {
  constructor(tui, editor, statusArea, footerBar) {
    this.tui = tui;
    this.output = new Container();
    this.editor = editor;
    this.statusArea = statusArea;
    this.footerBar = footerBar;
    this._focused = false;
  }

  get focused() { return this._focused; }
  set focused(v) {
    this._focused = v;
    this.editor.focused = v;
  }

  handleInput(data) {
    this.editor.handleInput(data);
  }

  invalidate() {
    this.output.invalidate?.();
    this.editor.invalidate?.();
    this.statusArea.invalidate?.();
    this.footerBar.invalidate?.();
  }

  render(width) {
    const outputLines = this.output.render(width);
    const statusLines = this.statusArea.render(width);
    const editorLines = this.editor.render(width);
    const footerLines = this.footerBar.render(width);

    // Place ❯ prompt on first content line of editor (after top border)
    if (editorLines.length > 1) {
      editorLines[1] = truncateToWidth(chalk.green.bold("❯ ") + editorLines[1].slice(1), width);
    }

    const allLines = [...outputLines, ...statusLines, ...editorLines, ...footerLines];
    // pi-tui requires every render line to be a string; guard against
    // components that occasionally yield non-string values (causes
    // "line.startsWith is not a function" crash in applyLineResets).
    for (let i = 0; i < allLines.length; i++) {
      if (typeof allLines[i] !== "string") {
        const src = i < outputLines.length ? "output"
          : i < outputLines.length + statusLines.length ? "status"
          : i < outputLines.length + statusLines.length + editorLines.length ? "editor"
          : "footer";
        logger.warn(`[UI] non-string render line at index ${i} (${src}): ${typeof allLines[i]} ${JSON.stringify(allLines[i])}`);
        allLines[i] = String(allLines[i] ?? "");
      }
    }
    return allLines;
  }

  addLog(text) {
    this.output.addChild(new Text(text, 0, 0));
    this.tui.requestRender();
  }

  addLogMarkdown(prefixLine, rest) {
    this.output.addChild(new Spacer(1));
    this.output.addChild(new Text(prefixLine, 0, 0));
    if (rest && rest.trim()) {
      this.output.addChild(new Markdown(rest, 1, 0, markdownTheme));
    }
    this.tui.requestRender();
  }
}

// ═══ Helpers ═══

function summarizeArgs(args) {
  if (!args) return "";
  const parts = [];
  for (const [k, v] of Object.entries(args)) {
    const s = typeof v === "string" ? v : JSON.stringify(v);
    parts.push(`${k}: ${s.length > 50 ? s.slice(0, 47) + "..." : s}`);
  }
  return parts.join(", ");
}

/**
 * Run a git command asynchronously.
 * Returns stdout trimmed, or null on failure.
 */
function execGitAsync(args, cwd) {
  return new Promise((resolve) => {
    execFile("git", args, { cwd, encoding: "utf-8", timeout: 5000 }, (err, stdout) => {
      if (err) return resolve(null);
      resolve((stdout || "").trim());
    });
  });
}

/**
 * Get git diff stats (lines added/removed) for the working directory.
 * Returns { branch, added, removed } or null if not in a git repo.
 */
async function getGitStats(cwd) {
  try {
    const branch = await execGitAsync(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
    if (!branch) return null;

    const diffStats = await execGitAsync(["diff", "--numstat"], cwd);

    let added = 0;
    let removed = 0;
    if (diffStats) {
      for (const line of diffStats.split("\n")) {
        const [add, rem] = line.split("\t");
        // Binary files show "-" for add/rem
        if (add !== "-" && rem !== "-") {
          added += parseInt(add, 10) || 0;
          removed += parseInt(rem, 10) || 0;
        }
      }
    }

    return { branch, added, removed };
  } catch {
    return null;
  }
}

/**
 * Build the left part of the context bar (model + token usage).
 */
function buildContextBarLeft(modelName, tokenUsage) {
  const modelPart = chalk.magenta(modelName || "");
  if (!tokenUsage) return " " + modelPart + chalk.dim(" |");
  const { percentage, used, max } = tokenUsage;
  const barWidth = 10;
  const filled = Math.round((percentage / 100) * barWidth);
  const bar = "█".repeat(filled) + "░".repeat(barWidth - filled);
  let colorFn;
  if (percentage > 90) colorFn = chalk.red.bold;
  else if (percentage > 75) colorFn = chalk.yellow;
  else if (percentage > 50) colorFn = chalk.cyan;
  else colorFn = chalk.green;
  const formatTokens = (n) => (n >= 1000 ? `${Math.round(n / 1000)}K` : String(n));
  return " " + modelPart + chalk.dim(" | ") + colorFn(`[${bar}] ${percentage}%`) + chalk.dim(` ${formatTokens(used)}/${formatTokens(max)} |`);
}

/**
 * Build the right part of the context bar (git stats).
 */
function buildContextBarRight(gitStats) {
  if (!gitStats) return "";
  const branchPart = chalk.cyan(gitStats.branch);
  if (gitStats.added > 0 || gitStats.removed > 0) {
    const addPart = chalk.green(`+${gitStats.added}`);
    const remPart = chalk.red(`-${gitStats.removed}`);
    return chalk.dim("[") + branchPart + chalk.dim("] ") + addPart + " " + remPart + " ";
  }
  return chalk.dim("[") + branchPart + chalk.dim("] ");
}

/**
 * Build the full context bar with right-justified git stats.
 */
function buildContextBar(modelName, tokenUsage, gitStats, width) {
  const leftPart = buildContextBarLeft(modelName, tokenUsage);
  const rightPart = buildContextBarRight(gitStats);

  if (!rightPart) return leftPart;

  // Calculate padding needed to right-justify git stats
  // Use visibleWidth to handle ANSI escape codes correctly
  const leftLength = visibleWidth(leftPart);
  const rightLength = visibleWidth(rightPart);
  const padding = Math.max(1, width - leftLength - rightLength);

  return leftPart + " ".repeat(padding) + rightPart;
}

// ═══ Main entry point ═══

export function startApp(agent, initialPrompt) {
  const terminal = new ProcessTerminal();
  const tui = new TUI(terminal);

  // ── State ──
  let busy = false;
  let askState = null;
  let approvalState = null;
  let lastCtrlC = 0;
  let tokenUsage = null;
  let streamContent = "";
  let statusText = "";
  let streamThrottle = null;
  let contextReady = false;
  let minTimeElapsed = false;
  let isLoading = true;
  let gitStats = null;

  // ── Loading screen ──
  const loadingAnim = new LoadingAnimation(tui, agent.model);
  tui.addChild(loadingAnim);

  // ── Main UI components ──
  const statusArea = new StatusArea(() => ({
    busy,
    streamContent,
    statusText,
    askState,
    approvalState,
  }), tui);

  const footerBar = new FooterBar(() => ({
    modelName: agent.model,
    tokenUsage,
    gitStats,
  }));

  const editor = new Editor(tui, editorTheme);
  editor.setPaddingX(1);

  // Set up autocomplete
  const slashCommands = [
    { name: "model", description: "Switch or list models (/model <name> or /model list)" },
    { name: "clear", description: "Clear conversation history" },
    { name: "inspect", description: "Dump context to file" },

    { name: "exit", description: "Exit the agent" },
  ];
  const autocompleteProvider = new CombinedAutocompleteProvider(slashCommands, agent.jailDirectory || process.cwd());
  editor.setAutocompleteProvider(autocompleteProvider);

  // ── ChatView ──
  const chatView = new ChatView(tui, editor, statusArea, footerBar);

  let gitStatsCache = { result: null, timestamp: 0 };
  const GIT_STATS_TTL = 10_000; // 10 seconds

  function updateContextBar() {
    // Refresh git stats when updating context bar (cached with TTL)
    const now = Date.now();
    if (now - gitStatsCache.timestamp > GIT_STATS_TTL) {
      gitStatsCache.timestamp = now; // Prevent concurrent fetches
      getGitStats(agent.jailDirectory || process.cwd()).then((result) => {
        gitStatsCache.result = result;
        gitStats = result;
        footerBar.invalidate();
        tui.requestRender();
      }).catch(() => {
        gitStatsCache.result = null;
        gitStats = null;
      });
    }
    gitStats = gitStatsCache.result;
    footerBar.invalidate();
    tui.requestRender();
  }

  // Load git stats on startup
  updateContextBar();

  // ── Transition from loading to main UI ──
  function switchToMainUI() {
    if (!isLoading) return;
    isLoading = false;
    loadingAnim.stop();
    tui.removeChild(loadingAnim);

    tui.addChild(chatView);
    tui.setFocus(chatView);
    tui.requestRender();

    if (initialPrompt) {
      submit(initialPrompt);
    }
  }

  // ── Submit handler ──
  async function submit(text) {
    if (!text.trim()) return;
    const trimmed = text.trim();

    if (trimmed === "exit" || trimmed === "quit" || trimmed === "/exit" || trimmed === "/quit") {
      cleanup();
      process.exit(0);
    }

    if (trimmed === "/clear") {
      agent.reset();
      chatView.output.clear();
      chatView.addLog(chalk.dim("    ⎿  (conversation cleared)"));
      return;
    }

    if (trimmed === "/reflect") {
      // Read recent logs and analyze for skill development opportunities
      const logs = readRecentLogs(1000);
      if (!logs) {
        chatView.addLog(chalk.red(" ✗ No logs available for reflection"));
        return;
      }

      const reflectPrompt = `Analyze the following agent session logs to identify patterns, repetitive tasks, or areas where the agent could benefit from a new skill. A skill is a reusable procedure that helps the agent work more effectively.

## What to look for:
1. **Repetitive patterns** - Similar tool call sequences that could be automated
2. **Common mistakes** - Errors that could be avoided with a checklist or procedure
3. **Missing knowledge** - Domain-specific patterns the agent repeatedly discovers
4. **Workflow improvements** - Multi-step processes that could be documented

## Instructions:
- If you find a good skill opportunity, write it as a markdown file to .smol-agent/skills/<name>.md
- Use YAML frontmatter with: name, description, triggers (when to use)
- The skill content should be practical guidance the agent can follow
- After writing the skill, confirm it was created and explain why it will help

## Agent Logs:
\`\`\`
${logs}
\`\`\`

Reflect on these logs and determine if there's a skill worth creating. If the logs don't show clear patterns for improvement, explain what you observed.`;

      chatView.addLog(chalk.dim("    ⎿  (reflecting on agent logs for skill opportunities...)"));
      chatView.addLog("");
      busy = true;
      statusText = "reflecting...";
      tui.requestRender();

      try {
        await agent.run(reflectPrompt);
        // Refresh context to pick up any newly created skills
        await agent.refreshContext();
        chatView.addLog(chalk.dim("    ⎿  (skills context refreshed)"));
      } catch (err) {
        chatView.addLog(chalk.red(` ✗ Reflection failed: ${err.message}`));
      } finally {
        busy = false;
        statusText = "";
        tui.requestRender();
      }
      return;
    }

    if (trimmed === "/inspect") {
      try {
        const context = await agent.getContext();
        const contextPath = join(agent.jailDirectory, "CONTEXT.md");
        writeFileSync(contextPath, context, "utf-8");
        chatView.addLog(chalk.dim(`    ⎿  (context saved to ${contextPath})`));
      } catch (err) {
        chatView.addLog(chalk.red(` ✗ Failed to save context: ${err.message}`));
      }
      return;
    }

    if (trimmed.startsWith("/model")) {
      const parts = trimmed.split(/\s+/);
      if (parts.length === 1) {
        chatView.addLog(chalk.dim(`    ⎿  Current model: ${agent.model}`));
      } else if (parts[1] === "?" || parts[1] === "list") {
        try {
          const models = await listModels(agent.client);
          if (models.length === 0) {
            chatView.addLog(chalk.dim("    ⎿  No models found. Pull a model with: ollama pull <model>"));
          } else {
            const sorted = models.map((m) => m.name).sort((a, b) => a.localeCompare(b));
            chatView.addLog(chalk.dim("    ⎿  Available models:\n" + sorted.map((n) => `        ${n}`).join("\n")));
          }
        } catch (err) {
          chatView.addLog(chalk.red(` ✗ Failed to list models: ${err.message}`));
        }
      } else {
        const newModel = parts[1];
        agent.setModel(newModel);
        chatView.addLog(chalk.dim(`    ⎿  Switched to model: ${newModel}`));
        updateContextBar();
      }
      return;
    }

    chatView.addLog("");
    chatView.addLog(chalk.green.bold(" > ") + chalk.bold(trimmed));
    busy = true;
    statusText = "thinking...";
    tui.requestRender();

    try {
      await agent.run(trimmed);
      // Flush remaining streamed content (only text from the last iteration,
      // since stream_start resets streamContent each iteration).
      // This avoids duplication when the model repeats earlier text.
      const finalStream = streamContent.replace(/<thinking>[\s\S]*?<\/thinking>/g, "").trim();
      streamContent = "";
      if (streamThrottle) { clearTimeout(streamThrottle); streamThrottle = null; }
      if (finalStream) {
        const lines = finalStream.split("\n");
        const first = lines[0];
        const rest = lines.slice(1).join("\n").trim();
        chatView.addLogMarkdown(chalk.cyan.bold(" ▸  ") + first, rest);
      }
    } catch (err) {
      streamContent = "";
      if (streamThrottle) { clearTimeout(streamThrottle); streamThrottle = null; }
      chatView.addLog(chalk.red(` ✗ ${err.message}`));
    }

    busy = false;
    statusText = "";
    tui.requestRender();
  }

  // ── Editor submit ──
  editor.onSubmit = (text) => {
    // Add to history for up/down arrow navigation
    editor.addToHistory(text);
    editor.setText("");

    if (askState) {
      const answer = text.trim();
      chatView.addLog(chalk.dim("    ⎿  ") + chalk.bold(`(answer) ${answer}`));
      askState.resolve(answer);
      askState = null;
      busy = true;
      statusText = "thinking...";
      tui.requestRender();
      return;
    }

    if (busy) {
      const nudge = text.trim();
      if (nudge) {
        agent.inject(nudge);
        chatView.addLog("");
        chatView.addLog(chalk.yellow.bold(" >> ") + chalk.yellow(nudge));
      }
      return;
    }

    submit(text.trim());
  };

  // ── Agent events ──
  const onStreamStart = () => {
    streamContent = "";
    statusText = "";
    tui.requestRender();
  };

  const onToken = ({ content }) => {
    streamContent += content;
    if (!streamThrottle) {
      streamThrottle = setTimeout(() => {
        streamThrottle = null;
        tui.requestRender();
      }, 33);
    }
  };

  const onStreamEnd = () => {
    if (streamThrottle) { clearTimeout(streamThrottle); streamThrottle = null; }
    tui.requestRender();
  };

  const onThinking = ({ content }) => {
    const lines = (content || "").split("\n");
    const formatted = lines.map((l, i) =>
      chalk.dim(i === 0 ? `    🧠 ${l}` : `       ${l}`),
    ).join("\n");
    chatView.addLog(formatted);
  };

  const onToolCall = ({ name, args }) => {
    if (streamContent) {
      const text = streamContent.replace(/<thinking>[\s\S]*?<\/thinking>/g, "").trim();
      streamContent = "";
      if (streamThrottle) { clearTimeout(streamThrottle); streamThrottle = null; }
      if (text) {
        const lines = text.split("\n");
        const first = lines[0];
        const rest = lines.slice(1).join("\n").trim();
        chatView.addLogMarkdown(chalk.cyan.bold(" ▸  ") + first, rest);
      }
    }
    const summary = summarizeArgs(args);
    chatView.addLog(chalk.dim(`    ⎿  [tool] ${name}(${summary})`));
    tui.requestRender();
  };

  const onToolResult = () => {
    tui.requestRender();
  };

  const onTokenUsage = (usage) => {
    tokenUsage = usage;
    updateContextBar();
  };

  const onContextReady = () => {
    contextReady = true;
    if (minTimeElapsed) {
      chatView.addLog(chalk.dim("    ⎿  (project context gathered)"));
      switchToMainUI();
    }
  };

  const onError = (error) => {
    chatView.addLog(chalk.red(` ✗ ${error.message}`));
    tui.requestRender();
  };

  const onRetry = ({ attempt, maxRetries, message: msg }) => {
    chatView.addLog(chalk.dim(`    ⎿  (retry ${attempt}/${maxRetries}: ${msg})`));
    statusText = `retrying (${attempt}/${maxRetries})...`;
    tui.requestRender();
  };

  const onSubAgentProgress = (event) => {
    if (event.type === "start") {
      statusText = `delegate: ${(event.task || "researching").substring(0, 60)}...`;
    } else if (event.type === "tool_call") {
      statusText = `delegate → ${event.name}(${summarizeArgs(event.args).substring(0, 50)})`;
    } else if (event.type === "iteration") {
      statusText = `delegate: iteration ${event.current}/${event.max}`;
    } else if (event.type === "done") {
      statusText = "";
    }
    tui.requestRender();
  };

  agent.on("stream_start", onStreamStart);
  agent.on("token", onToken);
  agent.on("stream_end", onStreamEnd);
  agent.on("thinking", onThinking);
  agent.on("tool_call", onToolCall);
  agent.on("tool_result", onToolResult);
  agent.on("token_usage", onTokenUsage);
  agent.on("context_ready", onContextReady);
  agent.on("error", onError);
  agent.on("retry", onRetry);
  agent.on("sub_agent_progress", onSubAgentProgress);

  // ── ask_user handler ──
  setAskHandler((question) =>
    new Promise((resolve) => {
      askState = { question, resolve };
      busy = false;
      tui.requestRender();
    }),
  );

  // ── Tool approval handler ──
  agent.setApprovalHandler((name, args) =>
    new Promise((resolve) => {
      approvalState = { name, args, resolve };
      busy = false;
      statusText = "";
      tui.requestRender();
    }),
  );

  // ── Global key handler ──
  tui.addInputListener((data) => {
    // Ctrl+C: cancel/exit
    if (matchesKey(data, "ctrl+c")) {
      const now = Date.now();
      if (now - lastCtrlC < 500) {
        cleanup();
        process.exit(0);
      } else {
        if (approvalState) {
          const { name, resolve } = approvalState;
          chatView.addLog(chalk.dim(`    ⎿  (denied ${name})`));
          resolve({ approved: false });
          approvalState = null;
          lastCtrlC = now;
          return { consume: true };
        }
        if (busy) {
          agent.cancel();
          streamContent = "";
          if (streamThrottle) { clearTimeout(streamThrottle); streamThrottle = null; }
          chatView.addLog(chalk.dim("    ⎿  (operation cancelled — press Ctrl+C again to quit)"));
          busy = false;
          statusText = "";
        } else {
          chatView.addLog(chalk.dim("    ⎿  (press Ctrl+C again to quit)"));
        }
        tui.requestRender();
        lastCtrlC = now;
      }
      return { consume: true };
    }

    // Approval state: y/n/a
    if (approvalState) {
      const { name, resolve } = approvalState;
      if (data === "y" || matchesKey(data, "enter")) {
        chatView.addLog(chalk.dim(`    ⎿  (approved ${name})`));
        resolve({ approved: true });
        approvalState = null;
      } else if (data === "n") {
        chatView.addLog(chalk.dim(`    ⎿  (denied ${name})`));
        resolve({ approved: false });
        approvalState = null;
      } else if (data === "a") {
        chatView.addLog(chalk.dim("    ⎿  (approved all future tool calls — saved to settings)"));
        resolve({ approved: true, approveAll: true });
        approvalState = null;
        saveSetting(agent.jailDirectory, "autoApprove", true).catch((err) => {
          chatView.addLog(chalk.dim(`    ⎿  (failed to save setting: ${err.message})`));
        });
      }
      if (!approvalState) {
        busy = true;
        statusText = "thinking...";
      }
      tui.requestRender();
      return { consume: true };
    }
  });

  // ── Cleanup ──
  function cleanup() {
    statusArea.stopAnimation();
    loadingAnim.stop();
    if (streamThrottle) { clearTimeout(streamThrottle); streamThrottle = null; }
    agent.off("stream_start", onStreamStart);
    agent.off("token", onToken);
    agent.off("stream_end", onStreamEnd);
    agent.off("thinking", onThinking);
    agent.off("tool_call", onToolCall);
    agent.off("tool_result", onToolResult);
    agent.off("token_usage", onTokenUsage);
    agent.off("context_ready", onContextReady);
    agent.off("error", onError);
    agent.off("retry", onRetry);
    agent.off("sub_agent_progress", onSubAgentProgress);
    tui.stop();
  }

  // ── Init ──
  agent._init().catch(() => {
    contextReady = true;
    if (minTimeElapsed) switchToMainUI();
  });

  setTimeout(() => {
    minTimeElapsed = true;
    if (contextReady) {
      chatView.addLog(chalk.dim("    ⎿  (project context gathered)"));
      switchToMainUI();
    }
  }, 5000);

  tui.start();
}
