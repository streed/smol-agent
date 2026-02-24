import React, { useState, useEffect, useCallback } from "react";
import { Box, Text, useApp, useInput } from "ink";
import TextInput from "ink-text-input";
import Spinner from "ink-spinner";
import { setAskHandler } from "../tools/ask_user.js";

const e = React.createElement;

export default function App({ agent, initialPrompt }) {
  const { exit } = useApp();

  const [log, setLog] = useState([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [statusText, setStatusText] = useState("");
  const [askState, setAskState] = useState(null);

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
    const onError = (err) => {
      setLog((prev) => [...prev, { role: "error", text: err.message }]);
      setBusy(false);
      setStatusText("");
    };

    agent.on("tool_call", onToolCall);
    agent.on("tool_result", onToolResult);
    agent.on("error", onError);

    return () => {
      agent.off("tool_call", onToolCall);
      agent.off("tool_result", onToolResult);
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
      if (text.trim() === "/help") {
        setLog((prev) => [
          ...prev,
          {
            role: "tool",
            text: "Commands: /reset — clear conversation  |  exit/quit — exit  |  Ctrl-C — exit",
          },
        ]);
        return;
      }

      setLog((prev) => [...prev, { role: "user", text: text.trim() }]);
      setBusy(true);
      setStatusText("thinking...");

      try {
        const answer = await agent.run(text.trim());
        setLog((prev) => [...prev, { role: "agent", text: answer }]);
      } catch (err) {
        setLog((prev) => [...prev, { role: "error", text: err.message }]);
      }
      setBusy(false);
      setStatusText("");
    },
    [agent, exit]
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

  useInput((ch, key) => {
    if (key.ctrl && ch === "c") {
      exit();
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
    !busy &&
      e(
        Box,
        { marginTop: 1 },
        e(Text, { bold: true, color: "green" }, `${promptLabel}> `),
        e(TextInput, {
          value: input,
          onChange: setInput,
          onSubmit: handleSubmit,
        })
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
      e(Text, null, text)
    );
  }
  if (role === "agent") {
    return e(
      Box,
      { marginTop: 1, marginBottom: 1 },
      e(Text, { bold: true, color: "cyan" }, "agent> "),
      e(Text, null, text)
    );
  }
  if (role === "tool") {
    return e(Text, { dimColor: true }, `  ${text}`);
  }
  if (role === "error") {
    return e(Text, { color: "red" }, `error: ${text}`);
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
