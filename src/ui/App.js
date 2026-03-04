import {
  ProcessTerminal,
  TUI,
  Text,
  Container,
  Editor,
  Markdown,
  Spacer,
  matchesKey,
  truncateToWidth,
} from "@mariozechner/pi-tui";
import chalk from "chalk";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { setAskHandler } from "../tools/ask_user.js";
import { saveSetting } from "../settings.js";
import { listModels } from "../ollama.js";

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

// ═══ StatusArea component ═══
// Renders live status: streaming text, spinner, ask prompt, approval prompt

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
      const first = sLines[0] || "";
      const rest = sLines.length > 1 ? sLines.slice(1).join("\n") : null;
      lines.push("");
      const cursor = chalk.cyan("▌");
      const firstLine = chalk.cyan.bold(" ⏺  ") + first + (rest ? "" : cursor);
      lines.push(truncateToWidth(firstLine, width));
      if (rest) {
        const restLine = "     " + rest + cursor;
        lines.push(truncateToWidth(restLine, width));
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

function buildContextBar(tokenUsage) {
  const hint = chalk.dim("ctrl+j newline · type while busy to nudge · /model · /reset · /exit ");
  if (!tokenUsage) return hint;
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
  return colorFn(`[${bar}] ${percentage}%`) + chalk.dim(` ${formatTokens(used)}/${formatTokens(max)}  `) + hint;
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

  // ── Loading screen ──
  const loadingAnim = new LoadingAnimation(tui, agent.model);
  tui.addChild(loadingAnim);

  // ── Main UI components ──
  const logContainer = new Container();

  const statusArea = new StatusArea(() => ({
    busy,
    streamContent,
    statusText,
    askState,
    approvalState,
  }), tui);

  const contextBarText = new Text(buildContextBar(null), 0, 0);

  const editor = new Editor(tui, editorTheme);

  // ── Add message to the log ──
  function addLog(text) {
    logContainer.addChild(new Text(text, 0, 0));
    tui.requestRender();
  }

  function addLogMarkdown(prefixLine, rest) {
    logContainer.addChild(new Text("", 0, 0)); // blank spacer line
    logContainer.addChild(new Text(prefixLine, 0, 0));
    if (rest && rest.trim()) {
      logContainer.addChild(new Markdown(rest, 1, 0, markdownTheme));
    }
    tui.requestRender();
  }

  function updateContextBar() {
    contextBarText.setText(buildContextBar(tokenUsage));
    tui.requestRender();
  }

  // ── Transition from loading to main UI ──
  function switchToMainUI() {
    if (!isLoading) return;
    isLoading = false;
    loadingAnim.stop();
    tui.removeChild(loadingAnim);

    const headerLine = chalk.dim("╭─ ◉ smol-agent ") + chalk.magenta(agent.model) + chalk.dim(" ─╮");
    tui.addChild(new Text(headerLine, 0, 0));
    tui.addChild(new Spacer(1));
    tui.addChild(logContainer);
    tui.addChild(statusArea);
    tui.addChild(editor);
    tui.addChild(contextBarText);
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

    if (trimmed === "/reset") {
      agent.reset();
      addLog(chalk.dim("    ⎿  (conversation reset)"));
      return;
    }

    if (trimmed === "/inspect") {
      try {
        const context = await agent.getContext();
        const contextPath = join(agent.jailDirectory, "CONTEXT.md");
        writeFileSync(contextPath, context, "utf-8");
        addLog(chalk.dim(`    ⎿  (context saved to ${contextPath})`));
      } catch (err) {
        addLog(chalk.red(` ✗ Failed to save context: ${err.message}`));
      }
      return;
    }

    if (trimmed.startsWith("/model")) {
      const parts = trimmed.split(/\s+/);
      if (parts.length === 1) {
        addLog(chalk.dim(`    ⎿  Current model: ${agent.model}`));
      } else if (parts[1] === "?" || parts[1] === "list") {
        try {
          const models = await listModels(agent.client);
          if (models.length === 0) {
            addLog(chalk.dim("    ⎿  No models found. Pull a model with: ollama pull <model>"));
          } else {
            const sorted = models.map((m) => m.name).sort((a, b) => a.localeCompare(b));
            addLog(chalk.dim("    ⎿  Available models:\n" + sorted.map((n) => `        ${n}`).join("\n")));
          }
        } catch (err) {
          addLog(chalk.red(` ✗ Failed to list models: ${err.message}`));
        }
      } else {
        const newModel = parts[1];
        agent.setModel(newModel);
        addLog(chalk.dim(`    ⎿  Switched to model: ${newModel}`));
      }
      return;
    }

    addLog("");
    addLog(chalk.green.bold(" > ") + chalk.bold(trimmed));
    busy = true;
    statusText = "thinking...";
    tui.requestRender();

    try {
      const answer = await agent.run(trimmed);
      streamContent = "";
      if (streamThrottle) { clearTimeout(streamThrottle); streamThrottle = null; }
      if (answer) {
        const lines = answer.split("\n");
        const first = lines[0];
        const rest = lines.slice(1).join("\n").trim();
        addLogMarkdown(chalk.cyan.bold(" ⏺  ") + first, rest);
      }
    } catch (err) {
      streamContent = "";
      if (streamThrottle) { clearTimeout(streamThrottle); streamThrottle = null; }
      addLog(chalk.red(` ✗ ${err.message}`));
    }

    busy = false;
    statusText = "";
    tui.requestRender();
  }

  // ── Editor submit ──
  editor.onSubmit = (text) => {
    editor.setText("");

    if (askState) {
      const answer = text.trim();
      addLog(chalk.dim("    ⎿  ") + chalk.bold(`(answer) ${answer}`));
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
        addLog("");
        addLog(chalk.yellow.bold(" >> ") + chalk.yellow(nudge));
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
    addLog(formatted);
  };

  const onToolCall = ({ name, args }) => {
    if (streamContent) {
      const text = streamContent;
      streamContent = "";
      if (streamThrottle) { clearTimeout(streamThrottle); streamThrottle = null; }
      const lines = text.split("\n");
      const first = lines[0];
      const rest = lines.slice(1).join("\n").trim();
      addLogMarkdown(chalk.cyan.bold(" ⏺  ") + first, rest);
    }
    const summary = summarizeArgs(args);
    statusText = `${name}(${summary})`;
    addLog(chalk.dim(`    ⎿  [tool] ${name}(${summary})`));
    tui.requestRender();
  };

  const onToolResult = () => {
    statusText = "";
    tui.requestRender();
  };

  const onTokenUsage = (usage) => {
    tokenUsage = usage;
    updateContextBar();
  };

  const onContextReady = () => {
    contextReady = true;
    if (minTimeElapsed) {
      addLog(chalk.dim("    ⎿  (project context gathered)"));
      switchToMainUI();
    }
  };

  const onError = (error) => {
    addLog(chalk.red(` ✗ ${error.message}`));
    tui.requestRender();
  };

  const onRetry = ({ attempt, maxRetries, message: msg }) => {
    addLog(chalk.dim(`    ⎿  (retry ${attempt}/${maxRetries}: ${msg})`));
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
      tui.requestRender();
    }),
  );

  // ── Global key handler ──
  tui.addInputListener((data) => {
    if (matchesKey(data, "ctrl+c")) {
      const now = Date.now();
      if (now - lastCtrlC < 500) {
        cleanup();
        process.exit(0);
      } else {
        if (approvalState) {
          const { name, resolve } = approvalState;
          addLog(chalk.dim(`    ⎿  (denied ${name})`));
          resolve({ approved: false });
          approvalState = null;
          lastCtrlC = now;
          return { consume: true };
        }
        if (busy) {
          agent.cancel();
          streamContent = "";
          if (streamThrottle) { clearTimeout(streamThrottle); streamThrottle = null; }
          addLog(chalk.dim("    ⎿  (operation cancelled — press Ctrl+C again to quit)"));
          busy = false;
          statusText = "";
        } else {
          addLog(chalk.dim("    ⎿  (press Ctrl+C again to quit)"));
        }
        tui.requestRender();
        lastCtrlC = now;
      }
      return { consume: true };
    }

    if (approvalState) {
      const { name, resolve } = approvalState;
      if (data === "y" || matchesKey(data, "enter")) {
        addLog(chalk.dim(`    ⎿  (approved ${name})`));
        resolve({ approved: true });
        approvalState = null;
      } else if (data === "n") {
        addLog(chalk.dim(`    ⎿  (denied ${name})`));
        resolve({ approved: false });
        approvalState = null;
      } else if (data === "a") {
        addLog(chalk.dim("    ⎿  (approved all future tool calls — saved to settings)"));
        resolve({ approved: true, approveAll: true });
        approvalState = null;
        saveSetting(agent.jailDirectory, "autoApprove", true).catch(() => {});
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
      addLog(chalk.dim("    ⎿  (project context gathered)"));
      switchToMainUI();
    }
  }, 5000);

  tui.start();
}
