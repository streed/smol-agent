import React from "react";
import { Text, Box } from "ink";

const e = React.createElement;

/**
 * MultilineInput - Claude Code-style bordered text input
 *
 * Renders a box with top/bottom borders, │ side borders, and a > prompt.
 * Accepts a `width` prop (total box width) from the parent.
 *
 *   ╭──────────────────────────────────────────────╮
 *   │ > first line of input                        │
 *   │   continuation line                          │
 *   ╰──────────────────────────────────────────────╯
 */
export function MultilineInput({ value, cursorOffset = 0, focus = true, width = 80 }) {
  const boxWidth = Math.max(width, 12);
  // Inside each row: "│ " + "> " + content + pad + " │"
  //                   2      2                    2   = 6 chars of chrome
  const contentWidth = Math.max(boxWidth - 6, 1);

  // ── Split & word-wrap ──
  const lines = value.split("\n");
  const displayLines = [];
  // Track which original line each display line belongs to
  const lineOrigins = [];

  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx];
    if (line.length <= contentWidth) {
      displayLines.push(line);
      lineOrigins.push(idx);
    } else {
      let rem = line;
      while (rem.length > 0) {
        displayLines.push(rem.slice(0, contentWidth));
        lineOrigins.push(idx);
        rem = rem.slice(contentWidth);
      }
    }
  }
  if (displayLines.length === 0) {
    displayLines.push("");
    lineOrigins.push(0);
  }

  // ── Cursor position (original lines) ──
  let cursorLine = 0, cursorCol = 0, charCount = 0;
  for (let i = 0; i < lines.length; i++) {
    if (charCount + lines[i].length >= cursorOffset) {
      cursorLine = i;
      cursorCol = cursorOffset - charCount;
      break;
    }
    charCount += lines[i].length + 1;
    cursorLine = i + 1;
    cursorCol = 0;
  }

  // ── Map cursor to display-line index (accounting for wrapping) ──
  let displayLine = 0, displayCol = 0;
  for (let i = 0; i <= cursorLine; i++) {
    const line = lines[i] || "";
    const widths = [];
    if (line.length <= contentWidth) {
      widths.push(line.length);
    } else {
      let rem = line;
      while (rem.length > 0) {
        widths.push(Math.min(rem.length, contentWidth));
        rem = rem.slice(contentWidth);
      }
    }
    if (i === cursorLine) {
      let colRem = cursorCol;
      for (let j = 0; j < widths.length; j++) {
        if (colRem <= widths[j]) {
          displayLine += j;
          displayCol = colRem;
          break;
        }
        colRem -= widths[j];
        if (j === widths.length - 1) { displayLine += j; displayCol = widths[j]; }
      }
      break;
    }
    displayLine += widths.length;
  }

  // ── Borders ──
  const topBorder = e(Text, { dimColor: true }, "\u256D" + "\u2500".repeat(boxWidth - 2) + "\u256E");
  const botBorder = e(Text, { dimColor: true }, "\u2570" + "\u2500".repeat(boxWidth - 2) + "\u256F");

  // ── Content rows ──
  const rows = displayLines.map((line, i) => {
    const isFirst = i === 0;
    const promptEl = isFirst
      ? e(Text, { color: "green", bold: true }, "> ")
      : e(Text, { dimColor: true }, "  ");

    const isCursorRow = i === displayLine && focus;

    if (isCursorRow) {
      const before = line.slice(0, displayCol);
      const cc = line.slice(displayCol, displayCol + 1) || " ";
      const after = line.slice(displayCol + 1);
      const visLen = before.length + 1 + after.length;
      const pad = " ".repeat(Math.max(0, contentWidth - visLen));

      return e(Box, { key: i },
        e(Text, { dimColor: true }, "\u2502 "),
        promptEl,
        e(Text, null, before),
        e(Text, { inverse: true }, cc),
        e(Text, null, after + pad),
        e(Text, { dimColor: true }, " \u2502"),
      );
    }

    const text = line;
    const pad = " ".repeat(Math.max(0, contentWidth - text.length));
    return e(Box, { key: i },
      e(Text, { dimColor: true }, "\u2502 "),
      promptEl,
      e(Text, null, text + pad),
      e(Text, { dimColor: true }, " \u2502"),
    );
  });

  return e(Box, { flexDirection: "column" },
    topBorder,
    ...rows,
    botBorder,
  );
}

/**
 * Hook to handle multiline input state and keyboard navigation
 *
 * Keybindings:
 *   Ctrl+J          Insert newline (also Shift+Enter where supported)
 *   Ctrl+A / Ctrl+E Start / end of line
 *   Ctrl+U / Ctrl+K Kill to start / end of line
 *   Ctrl+W          Kill previous word
 *   Ctrl+D          Delete forward (like Delete key)
 *   Alt+D           Delete word forward
 *   Alt+B / Alt+F   Word back / forward
 *   Ctrl+Left/Right Word navigation (same as Alt+B/F)
 *   Up / Down       Move between lines
 */
export function useMultilineInput(value, onChange) {
  const [cursorOffset, setCursorOffset] = React.useState(value.length);
  const isInternalChange = React.useRef(false);

  // Keep cursor in sync when value changes externally (e.g., cleared after submit)
  React.useEffect(() => {
    if (!isInternalChange.current) {
      setCursorOffset(value.length);
    }
    isInternalChange.current = false;
  }, [value]);

  // Helper: update value from within the hook without triggering cursor reset
  const updateValue = (newValue, newCursorPos) => {
    isInternalChange.current = true;
    onChange(newValue);
    setCursorOffset(newCursorPos);
  };

  // Split value into lines for cursor navigation
  const lines = value.split("\n");

  // Calculate current cursor line and column
  let cursorLine = 0, cursorCol = 0, charCount = 0;
  for (let i = 0; i < lines.length; i++) {
    const lineLen = lines[i].length;
    if (charCount + lineLen >= cursorOffset) {
      cursorLine = i;
      cursorCol = cursorOffset - charCount;
      break;
    }
    charCount += lineLen + 1;
    cursorLine = i + 1;
    cursorCol = 0;
  }

  // Get char offset of the start of a line
  const lineStartOffset = (lineIdx) => {
    let offset = 0;
    for (let i = 0; i < lineIdx; i++) {
      offset += (lines[i]?.length || 0) + 1;
    }
    return offset;
  };

  /**
   * Handle input events - call this from useInput
   * Returns true if the event was handled, false otherwise
   */
  const handleInput = (input, key) => {
    // ── Paste: multi-character input ──
    if (input && input.length > 1 && !key.ctrl && !key.meta) {
      updateValue(
        value.slice(0, cursorOffset) + input + value.slice(cursorOffset),
        cursorOffset + input.length
      );
      return true;
    }

    // ── Backspace (backward delete) ──
    // Most terminals send \x7f for Backspace which Ink maps to key.delete,
    // while some send \b which Ink maps to key.backspace. Handle both.
    if ((key.backspace || key.delete) && cursorOffset > 0) {
      updateValue(
        value.slice(0, cursorOffset - 1) + value.slice(cursorOffset),
        cursorOffset - 1
      );
      return true;
    }

    // ── Forward delete (Ctrl+D) ──
    if (key.ctrl && input === "d" && cursorOffset < value.length) {
      updateValue(
        value.slice(0, cursorOffset) + value.slice(cursorOffset + 1),
        cursorOffset
      );
      return true;
    }

    // ── Left arrow ──
    if (key.leftArrow) {
      if (key.ctrl || key.meta) {
        const before = value.slice(0, cursorOffset);
        const match = before.match(/\S+\s*$/);
        setCursorOffset(match ? cursorOffset - match[0].length : 0);
      } else {
        setCursorOffset(Math.max(0, cursorOffset - 1));
      }
      return true;
    }

    // ── Right arrow ──
    if (key.rightArrow) {
      if (key.ctrl || key.meta) {
        const after = value.slice(cursorOffset);
        const match = after.match(/^\s*\S+/);
        setCursorOffset(match ? cursorOffset + match[0].length : value.length);
      } else {
        setCursorOffset(Math.min(value.length, cursorOffset + 1));
      }
      return true;
    }

    // ── Up arrow ──
    if (key.upArrow && cursorLine > 0) {
      const prevLineLen = lines[cursorLine - 1]?.length || 0;
      setCursorOffset(lineStartOffset(cursorLine - 1) + Math.min(cursorCol, prevLineLen));
      return true;
    }

    // ── Down arrow ──
    if (key.downArrow && cursorLine < lines.length - 1) {
      const nextLineLen = lines[cursorLine + 1]?.length || 0;
      setCursorOffset(lineStartOffset(cursorLine + 1) + Math.min(cursorCol, nextLineLen));
      return true;
    }

    // ── Ctrl+A - start of line ──
    if (key.ctrl && input === "a") {
      setCursorOffset(lineStartOffset(cursorLine));
      return true;
    }

    // ── Ctrl+E - end of line ──
    if (key.ctrl && input === "e") {
      setCursorOffset(lineStartOffset(cursorLine) + (lines[cursorLine]?.length || 0));
      return true;
    }

    // ── Alt+B - word back ──
    if (key.meta && input === "b") {
      const before = value.slice(0, cursorOffset);
      const match = before.match(/\S+\s*$/);
      setCursorOffset(match ? cursorOffset - match[0].length : 0);
      return true;
    }

    // ── Alt+F - word forward ──
    if (key.meta && input === "f") {
      const after = value.slice(cursorOffset);
      const match = after.match(/^\s*\S+/);
      setCursorOffset(match ? cursorOffset + match[0].length : value.length);
      return true;
    }

    // ── Alt+D - delete word forward ──
    if (key.meta && input === "d") {
      const after = value.slice(cursorOffset);
      const match = after.match(/^\s*\S+/);
      if (match) {
        updateValue(
          value.slice(0, cursorOffset) + value.slice(cursorOffset + match[0].length),
          cursorOffset
        );
      }
      return true;
    }

    // ── Ctrl+U - kill to start of line ──
    if (key.ctrl && input === "u") {
      const start = lineStartOffset(cursorLine);
      updateValue(
        value.slice(0, start) + value.slice(cursorOffset),
        start
      );
      return true;
    }

    // ── Ctrl+K - kill to end of line ──
    if (key.ctrl && input === "k") {
      const lineEnd = lineStartOffset(cursorLine) + (lines[cursorLine]?.length || 0);
      updateValue(
        value.slice(0, cursorOffset) + value.slice(lineEnd),
        cursorOffset
      );
      return true;
    }

    // ── Ctrl+W - kill previous word ──
    if (key.ctrl && input === "w") {
      const before = value.slice(0, cursorOffset);
      const match = before.match(/\S+\s*$/);
      if (match) {
        const killStart = cursorOffset - match[0].length;
        updateValue(
          value.slice(0, killStart) + value.slice(cursorOffset),
          killStart
        );
      }
      return true;
    }

    // ── Insert newline: Ctrl+J sends \n; also Shift+Enter where terminal supports ──
    if (input === "\n" || (key.return && key.shift)) {
      updateValue(
        value.slice(0, cursorOffset) + "\n" + value.slice(cursorOffset),
        cursorOffset + 1
      );
      return true;
    }

    // ── Plain Enter - not handled here, let parent decide (submit) ──
    if (key.return) {
      return false;
    }

    // ── Regular character input ──
    if (input && !key.ctrl && !key.meta && input.charCodeAt(0) >= 32) {
      updateValue(
        value.slice(0, cursorOffset) + input + value.slice(cursorOffset),
        cursorOffset + input.length
      );
      return true;
    }

    return false;
  };

  return { cursorOffset, handleInput };
}

export default MultilineInput;
