import React, { useState, useEffect, useCallback, useRef } from "react";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import TextInput from "ink-text-input";
import Spinner from "ink-spinner";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { setAskHandler } from "../tools/ask_user.js";
import { Markdown } from "./markdown.js";

const isRawModeSupported = process.stdin.isTTY && typeof process.stdin.setRawMode === 'function';

const e = React.createElement;

// ═══ 3D Rotating Text Engine ═══
// Pixel font → 3D point cloud → Y-axis rotation matrix → perspective projection → z-buffer → ASCII
const PIXEL_FONT = {
  S: [' ##', '#  ', ' # ', '  #', '## '],
  M: ['#   #', '## ##', '# # #', '#   #', '#   #'],
  O: [' # ', '# #', '# #', '# #', ' # '],
  L: ['#  ', '#  ', '#  ', '#  ', '###'],
  A: [' # ', '# #', '###', '# #', '# #'],
  G: [' ##', '#  ', '# #', '# #', ' ##'],
  E: ['###', '#  ', '## ', '#  ', '###'],
  N: ['#  #', '## #', '# ##', '#  #', '#  #'],
  T: ['###', ' # ', ' # ', ' # ', ' # '],
  ' ': ['  ', '  ', '  ', '  ', '  '],
};

function generateLoadingFrames() {
  // Build 3D point cloud from text — 3 z-layers give visible depth during rotation
  const pts = [];
  let xOff = 0;
  for (const ch of 'SMOL AGENT') {
    const g = PIXEL_FONT[ch];
    if (!g) { xOff += 2; continue; }
    for (let r = 0; r < g.length; r++) {
      for (let c = 0; c < g[r].length; c++) {
        if (g[r][c] === '#') {
          pts.push([xOff + c, r, -0.6]);
          pts.push([xOff + c, r,  0.0]);
          pts.push([xOff + c, r,  0.6]);
        }
      }
    }
    xOff += g[0].length + 1;
  }
  // Center point cloud on X axis
  const maxX = pts.reduce((mx, p) => Math.max(mx, p[0]), 0);
  const cx = maxX / 2;
  for (const p of pts) p[0] -= cx;

  // Render 36 frames for a full 360° rotation
  const NUM = 36, W = 52, H = 7, D = 28;
  const shades = [' ', '░', '▒', '▓', '█'];
  const frames = [];

  for (let f = 0; f < NUM; f++) {
    const angle = (f / NUM) * Math.PI * 2;
    const ca = Math.cos(angle), sa = Math.sin(angle);
    const buf = Array.from({ length: H }, () => new Array(W).fill(' '));
    const zb  = Array.from({ length: H }, () => new Array(W).fill(-1e9));

    // Shade based on how directly the surface faces the camera
    const facing = Math.abs(ca);
    const ch = shades[facing > 0.7 ? 4 : facing > 0.4 ? 3 : facing > 0.15 ? 2 : facing > 0.05 ? 1 : 0];

    for (const [x, y, z] of pts) {
      // Y-axis rotation matrix
      const rx = x * ca - z * sa;
      const rz = x * sa + z * ca;
      // Perspective divide
      const pz = rz + D;
      if (pz < 1) continue;
      const s = D / pz;
      const sx = Math.round(rx * s + W / 2);
      const sy = Math.round(y * s + 1);

      if (sx >= 0 && sx < W && sy >= 0 && sy < H && rz > zb[sy][sx]) {
        zb[sy][sx] = rz;
        buf[sy][sx] = ch;
      }
    }
    frames.push(buf.map(r => r.join('').trimEnd()));
  }
  return frames;
}

const LOADING_FRAMES = generateLoadingFrames();

// Loading status messages
const LOADING_MESSAGES = [
  "Gathering project context...",
  "Mapping the codebase...",
  "Checking git status...",
  "Reading configs...",
  "Warming up the brain...",
  "Preparing tools...",
  "Almost ready...",
];

export default function App({ agent, initialPrompt }) {
  const { exit } = useApp();
  const lastCtrlC = useRef(0);
  const contextReady = useRef(false);
  const minTimeElapsed = useRef(false);

  const [log, setLog] = useState([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [statusText, setStatusText] = useState("");
  const [askState, setAskState] = useState(null);
  const [mode, setMode] = useState(agent.mode);
  const [tokenUsage, setTokenUsage] = useState(null);

  // Terminal width for full-width UI
  const { stdout } = useStdout();

  // Startup animation state
  const [isLoading, setIsLoading] = useState(true);
  const [loadingFrame, setLoadingFrame] = useState(0);
  const [loadingMessage, setLoadingMessage] = useState(LOADING_MESSAGES[0]);

  // Mode cycling - shift-tab cycles through: coding -> planning -> coding
  const modeNames = ["coding", "planning"];
  const cycleMode = useCallback(() => {
    const currentIndex = modeNames.indexOf(mode);
    const nextIndex = (currentIndex + 1) % modeNames.length;
    const newMode = modeNames[nextIndex];
    agent.setMode(newMode);
    setMode(newMode);
    return newMode;
  }, [mode, agent]);

  // Wire up ask_user handler
  useEffect(() => {
    setAskHandler((question) => {
      return new Promise((resolve) => {
        setAskState({ question, resolve });
        setBusy(false);
      });
    });
  }, []);

  // Listen to agent events
  useEffect(() => {
    const onToolCall = ({ name, args }) => {
      const summary = summarizeArgs(args);
      setStatusText(`${name}(${summary})`);
      setLog((prev) => [
        ...prev,
        { role: "tool", text: `[tool] ${name}(${summary})` },
      ]);
    };
    const onToolResult = () => {
      setStatusText("");
    };
    const onTokenUsage = ({ current, max, percentage }) => {
      setTokenUsage({ current, max, percentage });
    };
    const onContextReady = () => {
      contextReady.current = true;
      if (minTimeElapsed.current) {
        setIsLoading(false);
        setLog((prev) => [
          ...prev,
          { role: "tool", text: "(project context gathered)" },
        ]);
      }
    };
    const onResponse = ({ content }) => {
      // This is handled in the submit function, but we could log it here too if needed
    };
    const onReflection = ({ content }) => {
      if (content) {
        setLog((prev) => [
          ...prev,
          { role: "reflection", text: content },
        ]);
      }
    };
    
    const onError = (error) => {
      setLog((prev) => [...prev, { role: "error", text: error.message }]);
    };

    agent.on("tool_call", onToolCall);
    agent.on("tool_result", onToolResult);
    agent.on("token_usage", onTokenUsage);
    agent.on("context_ready", onContextReady);
    agent.on("response", onResponse);
    agent.on("error", onError);
    agent.on("reflection", onReflection);

    return () => {
      agent.off("tool_call", onToolCall);
      agent.off("tool_result", onToolResult);
      agent.off("token_usage", onTokenUsage);
      agent.off("context_ready", onContextReady);
      agent.off("response", onResponse);
      agent.off("error", onError);
      agent.off("reflection", onReflection);
    };
  }, [agent]);

  // Startup animation loop
  useEffect(() => {
    if (!isLoading) return;
    
    let msgIndex = 0;
    let frameCount = 0;
    const interval = setInterval(() => {
      setLoadingFrame((f) => (f + 1) % LOADING_FRAMES.length);
      frameCount++;
      // Cycle loading messages every ~1s (every 10 frames at 100ms)
      if (frameCount % 10 === 0) {
        setLoadingMessage(LOADING_MESSAGES[msgIndex]);
        msgIndex = (msgIndex + 1) % LOADING_MESSAGES.length;
      }
    }, 100);
    
    return () => clearInterval(interval);
  }, [isLoading]);

  // Eagerly initialize agent context so loading screen resolves
  // even without an initialPrompt
  useEffect(() => {
    agent._init().catch(() => {
      contextReady.current = true;
      if (minTimeElapsed.current) {
        setIsLoading(false);
      }
    });
  }, [agent]);

  // Minimum 5-second loading screen to show the 3D animation
  useEffect(() => {
    const timer = setTimeout(() => {
      minTimeElapsed.current = true;
      if (contextReady.current) {
        setIsLoading(false);
        setLog((prev) => [
          ...prev,
          { role: "tool", text: "(project context gathered)" },
        ]);
      }
    }, 5000);
    return () => clearTimeout(timer);
  }, []);

  const submit = useCallback(
    async (text) => {
      if (!text.trim()) return;

      if (text.trim() === "exit" || text.trim() === "quit") {
        exit();
        return;
      }
      if (text.trim() === "/reset") {
        agent.reset();
        setLog((prev) => [
          ...prev,
          { role: "tool", text: "(conversation reset)" },
        ]);
        return;
      }
      if (text.trim() === "/plan") {
        const newMode = agent.setMode("planning");
        setMode(newMode);
        setLog((prev) => [
          ...prev,
          { role: "tool", text: "(switched to planning mode — read-only)" },
        ]);
        return;
      }
      if (text.trim() === "/code") {
        const newMode = agent.setMode("coding");
        setMode(newMode);
        setLog((prev) => [
          ...prev,
          { role: "tool", text: "(switched to coding mode — full access)" },
        ]);
        return;
      }
      if (text.trim() === "/mode") {
        const newMode = mode === "planning" ? "coding" : "planning";
        agent.setMode(newMode);
        setMode(newMode);
        setLog((prev) => [
          ...prev,
          { role: "tool", text: `(switched to ${newMode} mode)` },
        ]);
        return;
      }

      setLog((prev) => [...prev, { role: "user", text: text.trim() }]);
      setBusy(true);
      setStatusText("thinking...");

      try {
        const answer = await agent.run(text.trim());
        setLog((prev) => [...prev, { role: "agent", text: answer }]);
        
        // Save plan file when in planning mode
        if (mode === "planning" && answer) {
          const planPath = join(agent.jailDirectory, "PLAN.md");
          try {
            writeFileSync(planPath, answer, "utf-8");
            setLog((prev) => [
              ...prev,
              { role: "tool", text: `(plan saved to PLAN.md)` },
            ]);
          } catch (writeErr) {
            setLog((prev) => [
              ...prev,
              { role: "error", text: `failed to save plan: ${writeErr.message}` },
            ]);
          }
        }
      } catch (err) {
        setLog((prev) => [...prev, { role: "error", text: err.message }]);
      }
      setBusy(false);
      setStatusText("");
    },
    [agent, exit, mode]
  );

  useEffect(() => {
    if (initialPrompt) {
      submit(initialPrompt);
    }
  }, []);

  const handleSubmit = useCallback(
    (value) => {
      if (askState) {
        const answer = value.trim();
        setLog((prev) => [
          ...prev,
          { role: "user", text: `(answer) ${answer}` },
        ]);
        askState.resolve(answer);
        setAskState(null);
        setBusy(true);
        setStatusText("thinking...");
        setInput("");
        return;
      }

      setInput("");
      submit(value);
    },
    [askState, submit]
  );

  // Handle Ctrl+C for cancellation/exit and Shift+Tab for mode switching
  useInput((ch, key) => {
    // Handle Ctrl+C (works in both raw and non-raw mode)
    if (key.ctrl && ch === "c") {
      const now = Date.now();
      if (now - lastCtrlC.current < 500) {
        // Double tap within 500ms - exit
        exit();
      } else {
        // Single tap - check if we should cancel or prepare for double tap
        if (busy) {
          // Cancel current operation
          agent.cancel();
          setLog((prev) => [...prev, { role: "tool", text: "(operation cancelled)" }]);
          setBusy(false);
          setStatusText("");
        }
        lastCtrlC.current = now;
      }
    }

    // Shift+Tab to cycle through modes (works in both raw and non-raw mode)
    if (key.shift && key.name === "tab") {
      const newMode = cycleMode();
      setLog((prev) => [
        ...prev,
        { role: "tool", text: `(switched to ${newMode} mode)` },
      ]);
    }
  });

  const contentWidth = (stdout?.columns || 80) - 4;

  // Header construction (shared between loading and main UI)
  const headerTitle = " ◉ smol-agent ";
  const headerFill = Math.max(0, contentWidth - 1 - headerTitle.length);
  const headerTop = "╭─" + headerTitle + "─".repeat(headerFill) + "╮";
  const headerBot = "╰" + "─".repeat(contentWidth) + "╯";

  // Show loading screen while context is being gathered
  if (isLoading) {
    return e(
      Box,
      { flexDirection: "column", paddingX: 1, paddingY: 1 },

      // Header
      e(Text, { dimColor: true }, headerTop),
      e(Box, { justifyContent: "center" },
        e(Text, { dimColor: true }, "("),
        e(Text, { color: "magenta" }, agent.model),
        e(Text, { dimColor: true }, ")")
      ),
      e(Text, { dimColor: true }, headerBot),

      // 3D rotating "SMOL AGENT" text
      e(Box, { flexDirection: "column", alignItems: "center", marginTop: 2 },
        ...LOADING_FRAMES[loadingFrame].map((line, i) =>
          e(Text, { key: i, color: "cyan", bold: true }, line)
        )
      ),

      // Loading message
      e(Box, { justifyContent: "center", marginTop: 1 },
        e(Text, { dimColor: true }, loadingMessage)
      ),

      // Spinner
      e(Box, { justifyContent: "center", marginTop: 1 },
        e(Text, { color: "yellow" }, e(Spinner, { type: "dots" })),
        e(Text, { dimColor: true }, " Loading...")
      )
    );
  }

  // Main UI - Claude Code style
  return e(
    Box,
    { flexDirection: "column", paddingX: 1 },

    // ===== HEADER =====
    e(Text, { dimColor: true }, headerTop),
    e(Box, null,
      e(Text, { dimColor: true }, "│  "),
      e(Text, { color: "magenta" }, agent.model),
      e(Box, { flexGrow: 1 }),
      e(Text, {
        color: mode === "planning" ? "yellow" : "green"
      }, `▣ ${mode} mode`),
      tokenUsage && e(Text, { dimColor: true }, `  │  `),
      tokenUsage && e(Text, { 
        color: tokenUsage.percentage > 90 ? "red" : tokenUsage.percentage > 75 ? "yellow" : "dimColor",
        bold: tokenUsage.percentage > 90
      }, `${tokenUsage.percentage}%`),
      e(Text, { dimColor: true }, "  │")
    ),
    e(Text, { dimColor: true }, headerBot),

    // Warning when raw mode is not supported
    !isRawModeSupported &&
      e(Text, { color: "yellow", dimColor: true }, "  ⚠ Advanced key handling not available"),

    // ===== MESSAGE LOG =====
    ...log.flatMap((entry) => {
      if (entry.role === "user") {
        return [
          e(Box, { marginTop: 1 },
            e(Text, { color: "green", bold: true }, " > "),
            e(Text, { bold: true }, entry.text || "")
          ),
        ];
      }
      if (entry.role === "agent") {
        const text = entry.text || "(empty response)";
        const lines = text.split('\n');
        const firstLine = lines[0];
        const rest = lines.slice(1).join('\n').trim();
        const result = [];
        result.push(
          e(Box, { marginTop: 1 },
            e(Text, { color: "cyan", bold: true }, " ⏺  "),
            e(Text, null, firstLine)
          )
        );
        if (rest) {
          result.push(
            e(Box, { marginLeft: 4 },
              e(Markdown, null, rest)
            )
          );
        }
        return result;
      }
      if (entry.role === "tool") {
        return [
          e(Text, { dimColor: true }, "    ⎿  " + (entry.text || ""))
        ];
      }
      if (entry.role === "reflection") {
        return [
          e(Box, { marginTop: 1 },
            e(Text, { color: "magenta", dimColor: true }, " ↺  reflection:"),
          ),
          e(Box, { marginLeft: 4 },
            e(Markdown, null, entry.text || "")
          ),
        ];
      }
      if (entry.role === "error") {
        return [
          e(Box, { marginTop: 1 },
            e(Text, { color: "red" }, " ✗ " + (entry.text || "unknown error"))
          ),
        ];
      }
      return [];
    }),

    // ===== SPINNER =====
    busy &&
      e(Box, { marginTop: 1, marginLeft: 1 },
        e(Text, { color: "cyan" }, e(Spinner, { type: "dots" })),
        e(Text, { dimColor: true }, ` ${statusText}`)
      ),

    // ===== ASK USER =====
    askState &&
      e(Box, { marginTop: 1 },
        e(Text, { bold: true, color: "magenta" }, " ?  "),
        e(Text, { bold: true }, askState.question)
      ),

    // ===== INPUT =====
    e(Box, { marginTop: 1 },
      e(Text, { color: "green", bold: true }, " > "),
      e(TextInput, {
        value: input,
        onChange: setInput,
        onSubmit: handleSubmit,
      })
    ),

    // ===== STATUS LINE =====
    e(Box, { marginTop: 0 },
      e(Text, { dimColor: true }, "  "),
      e(Text, {
        color: mode === "planning" ? "yellow" : "green",
        bold: true
      }, mode),
      (() => {
        const toolCalls = log.filter(x => x.role === "tool" && x.text?.startsWith("[tool]")).length;
        const turns = log.filter(x => x.role === "user").length;
        const parts = [];
        if (turns > 0) parts.push(`${turns} turn${turns !== 1 ? "s" : ""}`);
        if (toolCalls > 0) parts.push(`${toolCalls} tool call${toolCalls !== 1 ? "s" : ""}`);
        if (tokenUsage) parts.push(`${tokenUsage.percentage}% ctx`);
        return parts.length > 0
          ? e(Text, { dimColor: true }, " · " + parts.join(" · "))
          : null;
      })(),
      e(Box, { flexGrow: 1 }),
      e(Text, { dimColor: true }, "shift+tab mode · /reset · exit ")
    )
  );
}

// Simple word wrap function
function wrapText(text, maxWidth) {
  const lines = [];
  const words = text.split(' ');
  let current = "";
  
  for (const word of words) {
    if ((current + " " + word).trim().length <= maxWidth) {
      current = (current + " " + word).trim();
    } else {
      if (current) lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  
  return lines.length ? lines : [""];
}

function summarizeArgs(args) {
  if (!args) return "";
  const parts = [];
  for (const [k, v] of Object.entries(args)) {
    const s = typeof v === "string" ? v : JSON.stringify(v);
    parts.push(`${k}: ${s.length > 50 ? s.slice(0, 47) + "..." : s}`);
  }
  return parts.join(", ");
}
