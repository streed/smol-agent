import React, { useState, useEffect, useCallback, useRef } from "react";
import { Box, Text, useApp, useInput } from "ink";
import TextInput from "ink-text-input";
import Spinner from "ink-spinner";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { setAskHandler } from "../tools/ask_user.js";
import { Markdown } from "./markdown.js";

const isRawModeSupported = process.stdin.isTTY && typeof process.stdin.setRawMode === 'function';

const e = React.createElement;

export default function App({ agent, initialPrompt }) {
  const { exit } = useApp();
  const lastCtrlC = useRef(0);

  const [log, setLog] = useState([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [statusText, setStatusText] = useState("");
  const [askState, setAskState] = useState(null);
  const [mode, setMode] = useState(agent.mode);

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
    const onContextReady = () => {
      setLog((prev) => [
        ...prev,
        { role: "tool", text: "(project context gathered)" },
      ]);
    };
    const onResponse = ({ content }) => {
      // This is handled in the submit function, but we could log it here too if needed
    };
    const onError = (error) => {
      setLog((prev) => [...prev, { role: "error", text: error.message }]);
    };

    agent.on("tool_call", onToolCall);
    agent.on("tool_result", onToolResult);
    agent.on("context_ready", onContextReady);
    agent.on("response", onResponse);
    agent.on("error", onError);

    return () => {
      agent.off("tool_call", onToolCall);
      agent.off("tool_result", onToolResult);
      agent.off("context_ready", onContextReady);
      agent.off("response", onResponse);
      agent.off("error", onError);
    };
  }, [agent]);

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
      if (busy) {
        // First Ctrl-C during execution - cancel the operation
        if (now - lastCtrlC.current < 500) {
          // Double tap - exit
          exit();
        } else {
          // Single tap - cancel current operation
          agent.cancel();
          setLog((prev) => [...prev, { role: "tool", text: "(operation cancelled)" }]);
          setBusy(false);
          setStatusText("");
          lastCtrlC.current = now;
        }
      } else {
        // Not busy - exit on double tap
        if (now - lastCtrlC.current < 500) {
          exit();
        } else {
          lastCtrlC.current = now;
        }
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

  const promptLabel = askState ? "answer" : "you";

  return e(
    Box,
    { flexDirection: "column", padding: 1 },

    // Header
    e(
      Box,
      { marginBottom: 1 },
      e(Text, { bold: true, color: "cyan" }, "smol-agent"),
      e(Text, { dimColor: true }, ` (model: ${agent.model})`)
    ),

    // Warning when raw mode is not supported
    !isRawModeSupported &&
      e(
        Box,
        { marginTop: 1, marginBottom: 1 },
        e(Text, { color: "yellow" }, "Warning: Advanced key handling not available in this environment")
      ),

    // Message log
    ...log.map((entry, i) => e(MessageRow, { key: i, entry })),

    // Spinner while busy
    busy &&
      e(
        Box,
        null,
        e(Text, { color: "yellow" }, e(Spinner, { type: "dots" })),
        e(Text, { dimColor: true }, ` ${statusText}`)
      ),

    // Ask-user question banner
    askState &&
      e(
        Box,
        { marginTop: 1 },
        e(Text, { bold: true, color: "magenta" }, "Agent asks: "),
        e(Text, null, askState.question)
      ),

    // Input row
    e(
      Box,
      { marginTop: 1 },
      e(Text, { bold: true, color: "green" }, `${promptLabel}> `),
      e(TextInput, {
        value: input,
        onChange: setInput,
        onSubmit: handleSubmit,
      })
    ),

    // Mode indicator below input
    e(
      Box,
      { marginTop: 0 },
      e(Text, { 
        dimColor: true,
        color: mode === "planning" ? "yellow" : "green" 
      }, `  [${mode === "planning" ? "planning" : "coding"} mode]`)
    )
  );
}

function MessageRow({ entry }) {
  const { role, text } = entry;
  if (role === "user") {
    return e(
      Box,
      null,
      e(Text, { bold: true, color: "green" }, "you> "),
      e(Text, null, text || "")
    );
  }
  if (role === "agent") {
    return e(
      Box,
      { marginTop: 1, marginBottom: 1, flexDirection: "column" },
      e(Text, { bold: true, color: "cyan" }, "agent> "),
      e(Box, { marginTop: 1 }, e(Markdown, null, text || "(empty response)"))
    );
  }
  if (role === "tool") {
    return e(Text, { dimColor: true }, `  ${text || ""}`);
  }
  if (role === "error") {
    return e(Text, { color: "red" }, `error: ${text || "unknown error"}`);
  }
  return null;
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
