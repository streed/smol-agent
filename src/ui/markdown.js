import React from "react";
import { Text, Box } from "ink";

const e = React.createElement;

export function Markdown({ children }) {
  if (!children) return null;
  return e(Box, { flexDirection: "column" }, ...processMarkdown(children));
}

// ── Theme (glow dark-inspired) ──────────────────────────────────────

const THEME = {
  h1: { color: "magenta", bold: true },
  h2: { color: "blue", bold: true },
  h3: { color: "cyan", bold: true },
  h4: { color: "green", bold: true },
  h5: { color: "yellow", bold: true },
  h6: { bold: true },
  codeBar: { color: "gray", dimColor: true },
  codeText: { color: "green" },
  codeLang: { color: "magenta", dimColor: true },
  quoteBar: { color: "magenta" },
  quoteText: { dimColor: true, italic: true },
  hr: { dimColor: true },
  bullet: { color: "magenta" },
  ordNum: { color: "magenta" },
  tableHeader: { color: "cyan", bold: true },
  tableBorder: { dimColor: true },
  inlineCode: { color: "magenta" },
  link: { color: "blue", underline: true },
  linkUrl: { dimColor: true },
  taskDone: { color: "green" },
  taskOpen: { color: "gray" },
};

const BULLETS = ["•", "◦", "▸", "▹"];

// ── Main parser ─────────────────────────────────────────────────────

function processMarkdown(text) {
  if (!text) return [];
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const elements = [];
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Blank line
    if (!line.trim()) { i++; continue; }

    // Fenced code block
    if (line.match(/^(`{3,}|~{3,})/)) {
      const fence = line.match(/^(`{3,}|~{3,})/)[1];
      const lang = line.slice(fence.length).trim();
      const codeLines = [];
      i++;
      while (i < lines.length && !lines[i].startsWith(fence)) {
        codeLines.push(lines[i]);
        i++;
      }
      if (i < lines.length) i++; // skip closing fence
      elements.push(renderCodeBlock(codeLines, lang, key++));
      continue;
    }

    // Headings
    const hMatch = line.match(/^(#{1,6})\s+(.*)$/);
    if (hMatch) {
      const level = hMatch[1].length;
      const content = hMatch[2].replace(/\s+#+$/, "").trim();
      elements.push(renderHeading(content, level, key++));
      i++;
      continue;
    }

    // Horizontal rule
    if (/^(\s*[-_*]\s*){3,}$/.test(line.trim())) {
      elements.push(
        e(Box, { key: key++, marginTop: 1, marginBottom: 1 },
          e(Text, THEME.hr, "━".repeat(40)),
        ),
      );
      i++;
      continue;
    }

    // Blockquote
    if (line.startsWith(">")) {
      const quoteLines = [];
      while (i < lines.length && (lines[i].startsWith(">") || (lines[i].trim() === "" && i + 1 < lines.length && lines[i + 1]?.startsWith(">")))) {
        const q = lines[i].replace(/^>\s?/, "");
        quoteLines.push(q);
        i++;
      }
      elements.push(renderBlockquote(quoteLines, key++));
      continue;
    }

    // Task list item
    const taskMatch = line.match(/^(\s*)[-*]\s+\[([ xX])\]\s+(.*)$/);
    if (taskMatch) {
      const taskItems = [];
      while (i < lines.length) {
        const tm = lines[i].match(/^(\s*)[-*]\s+\[([ xX])\]\s+(.*)$/);
        if (!tm) break;
        taskItems.push({
          indent: Math.floor(tm[1].length / 2),
          checked: tm[2].toLowerCase() === "x",
          content: tm[3],
        });
        i++;
      }
      elements.push(renderTaskList(taskItems, key++));
      continue;
    }

    // Unordered list
    if (/^(\s*)[-*+]\s+/.test(line)) {
      const items = [];
      while (i < lines.length) {
        const m = lines[i].match(/^(\s*)[-*+]\s+(.*)$/);
        if (!m) break;
        items.push({ indent: Math.floor(m[1].length / 2), content: m[2] });
        i++;
      }
      elements.push(renderUnorderedList(items, key++));
      continue;
    }

    // Ordered list
    if (/^\s*\d+\.\s+/.test(line)) {
      const items = [];
      while (i < lines.length) {
        const m = lines[i].match(/^(\s*)(\d+)\.\s+(.*)$/);
        if (!m) break;
        items.push({ indent: Math.floor(m[1].length / 2), number: m[2], content: m[3] });
        i++;
      }
      elements.push(renderOrderedList(items, key++));
      continue;
    }

    // Table (requires header + separator)
    if (line.match(/^\|.+\|$/) && i + 1 < lines.length && lines[i + 1].match(/^\|[\s:|-]+\|$/)) {
      const tableLines = [line];
      i++;
      // separator row
      if (i < lines.length && lines[i].match(/^\|[\s:|-]+\|$/)) {
        tableLines.push(lines[i]);
        i++;
      }
      // data rows
      while (i < lines.length && lines[i].match(/^\|.+\|$/)) {
        tableLines.push(lines[i]);
        i++;
      }
      elements.push(renderTable(tableLines, key++));
      continue;
    }

    // Paragraph fallback — ALWAYS advances i to prevent infinite loops
    const paragraphLines = [];
    while (i < lines.length && lines[i].trim()) {
      const l = lines[i];
      if (
        l.match(/^(`{3,}|~{3,})/) ||
        l.match(/^#{1,6}\s/) ||
        l.match(/^(\s*)[-*+]\s+/) ||
        l.match(/^\s*\d+\.\s+/) ||
        l.match(/^\|.+\|$/) ||
        /^(\s*[-_*]\s*){3,}$/.test(l.trim()) ||
        l.startsWith(">")
      ) break;
      paragraphLines.push(l.trim());
      i++;
    }

    // If nothing was consumed (e.g. a pipe-line without table separator), force advance
    if (paragraphLines.length === 0) {
      paragraphLines.push(lines[i].trim());
      i++;
    }

    const pLines = paragraphLines.map((p, j) =>
      e(Box, { key: j }, ...processInlineFormatting(p)),
    );
    elements.push(
      e(Box, { key: key++, marginBottom: 1, flexDirection: "column" }, ...pLines),
    );
  }

  return elements;
}

// ── Block renderers ─────────────────────────────────────────────────

function renderHeading(content, level, key) {
  const styles = [THEME.h1, THEME.h2, THEME.h3, THEME.h4, THEME.h5, THEME.h6];
  const style = styles[Math.min(level - 1, 5)];
  const inline = processInlineFormatting(content);
  const children = [
    e(Box, { key: "text" }, ...inline.map((el, i) =>
      React.cloneElement(el, { ...style, key: i }),
    )),
  ];
  if (level === 1) {
    children.push(e(Text, { key: "ul", color: "magenta" }, "━".repeat(Math.min(content.length + 2, 40))));
  } else if (level === 2) {
    children.push(e(Text, { key: "ul", color: "blue", dimColor: true }, "─".repeat(Math.min(content.length + 2, 40))));
  }
  return e(Box, { key, marginTop: level <= 2 ? 1 : 0, marginBottom: 1, flexDirection: "column" }, ...children);
}

function renderCodeBlock(codeLines, lang, key) {
  const rows = [];
  if (lang) {
    rows.push(
      e(Box, { key: "lang" },
        e(Text, THEME.codeBar, "│ "),
        e(Text, THEME.codeLang, lang),
      ),
    );
  }
  codeLines.forEach((line, j) => {
    rows.push(
      e(Box, { key: j },
        e(Text, THEME.codeBar, "│ "),
        e(Text, THEME.codeText, line),
      ),
    );
  });
  return e(Box, { key, marginTop: 1, marginBottom: 1, flexDirection: "column" }, ...rows);
}

function renderBlockquote(lines, key) {
  const rows = lines.map((line, j) =>
    e(Box, { key: j },
      e(Text, THEME.quoteBar, "┃ "),
      e(Text, THEME.quoteText, line),
    ),
  );
  return e(Box, { key, marginTop: 1, marginBottom: 1, flexDirection: "column" }, ...rows);
}

function renderTaskList(items, key) {
  const rows = items.map((item, j) => {
    const icon = item.checked ? "✓" : "○";
    const style = item.checked ? THEME.taskDone : THEME.taskOpen;
    const inline = processInlineFormatting(item.content);
    return e(Box, { key: j, marginLeft: item.indent * 2 },
      e(Text, style, icon + " "),
      e(Text, null, ...inline),
    );
  });
  return e(Box, { key, marginBottom: 1, flexDirection: "column" }, ...rows);
}

function renderUnorderedList(items, key) {
  const rows = items.map((item, j) => {
    const bullet = BULLETS[Math.min(item.indent, BULLETS.length - 1)];
    const inline = processInlineFormatting(item.content);
    return e(Box, { key: j, marginLeft: item.indent * 2 },
      e(Text, THEME.bullet, bullet + " "),
      e(Text, null, ...inline),
    );
  });
  return e(Box, { key, marginBottom: 1, flexDirection: "column" }, ...rows);
}

function renderOrderedList(items, key) {
  const maxWidth = Math.max(...items.map((it) => it.number.length));
  const rows = items.map((item, j) => {
    const inline = processInlineFormatting(item.content);
    return e(Box, { key: j, marginLeft: item.indent * 2 },
      e(Text, THEME.ordNum, item.number.padStart(maxWidth) + ". "),
      e(Text, null, ...inline),
    );
  });
  return e(Box, { key, marginBottom: 1, flexDirection: "column" }, ...rows);
}

function renderTable(tableLines, key) {
  const parseRow = (line) => line.split("|").slice(1, -1).map((c) => c.trim());
  const headers = parseRow(tableLines[0]);
  const dataRows = tableLines.slice(2).map(parseRow);
  const colCount = headers.length;

  // Column widths (capped at 30)
  const colWidths = headers.map((h, ci) => {
    const dataMax = Math.max(0, ...dataRows.map((r) => (r[ci] || "").length));
    return Math.min(Math.max(h.length, dataMax), 30);
  });

  const rows = [];

  // Top border: ┌──┬──┐
  rows.push(e(Text, { key: "top", ...THEME.tableBorder },
    "┌" + colWidths.map((w) => "─".repeat(w + 2)).join("┬") + "┐",
  ));

  // Header row
  const hCells = headers.map((h, ci) =>
    e(Text, { key: ci, ...THEME.tableHeader }, " " + h.padEnd(colWidths[ci]) + " "),
  );
  rows.push(e(Box, { key: "hdr" },
    e(Text, THEME.tableBorder, "│"),
    ...hCells.flatMap((cell, ci) => [cell, e(Text, { key: "sep" + ci, ...THEME.tableBorder }, "│")]),
  ));

  // Header separator: ├──┼──┤
  rows.push(e(Text, { key: "hsep", ...THEME.tableBorder },
    "├" + colWidths.map((w) => "─".repeat(w + 2)).join("┼") + "┤",
  ));

  // Data rows
  dataRows.forEach((row, ri) => {
    const cells = [];
    for (let ci = 0; ci < colCount; ci++) {
      const val = (row[ci] || "").padEnd(colWidths[ci]);
      cells.push(e(Text, { key: ci }, " " + val + " "));
    }
    rows.push(e(Box, { key: "row" + ri },
      e(Text, THEME.tableBorder, "│"),
      ...cells.flatMap((cell, ci) => [cell, e(Text, { key: "sep" + ci, ...THEME.tableBorder }, "│")]),
    ));
  });

  // Bottom border: └──┴──┘
  rows.push(e(Text, { key: "bot", ...THEME.tableBorder },
    "└" + colWidths.map((w) => "─".repeat(w + 2)).join("┴") + "┘",
  ));

  return e(Box, { key, marginTop: 1, marginBottom: 1, flexDirection: "column" }, ...rows);
}

// ── Inline formatting ───────────────────────────────────────────────

function processInlineFormatting(text) {
  if (!text) return [e(Text, null, "")];
  const segments = splitIntoSegments(text);
  const elements = [];
  segments.forEach((seg, idx) => {
    if (seg.type === "text") elements.push(e(Text, { key: idx }, seg.content));
    else if (seg.type === "bold") elements.push(e(Text, { key: idx, bold: true }, seg.content));
    else if (seg.type === "italic") elements.push(e(Text, { key: idx, italic: true }, seg.content));
    else if (seg.type === "boldItalic") elements.push(e(Text, { key: idx, bold: true, italic: true }, seg.content));
    else if (seg.type === "code") elements.push(e(Text, { key: idx, ...THEME.inlineCode }, seg.content));
    else if (seg.type === "link") {
      elements.push(e(Text, { key: idx, ...THEME.link }, seg.text));
      elements.push(e(Text, { key: idx + "_url", ...THEME.linkUrl }, " (" + seg.url + ")"));
    }
    else if (seg.type === "strikethrough") elements.push(e(Text, { key: idx, strikethrough: true, dimColor: true }, seg.content));
    else elements.push(e(Text, { key: idx }, seg.content));
  });
  return elements;
}

function splitIntoSegments(text) {
  const segments = [];
  let remaining = text;
  while (remaining.length > 0) {
    const matches = [];
    let m;
    m = remaining.match(/\[([^\]]+)\]\(([^)]+)\)/);
    if (m) matches.push({ type: "link", index: m.index, length: m[0].length, text: m[1], url: m[2] });
    m = remaining.match(/\*\*\*([^*]+)\*\*\*/);
    if (m) matches.push({ type: "boldItalic", index: m.index, length: m[0].length, content: m[1] });
    m = remaining.match(/\*\*([^*]+)\*\*/);
    if (m) matches.push({ type: "bold", index: m.index, length: m[0].length, content: m[1] });
    m = remaining.match(/~~([^~]+)~~/);
    if (m) matches.push({ type: "strikethrough", index: m.index, length: m[0].length, content: m[1] });
    m = remaining.match(/`([^`]+)`/);
    if (m) matches.push({ type: "code", index: m.index, length: m[0].length, content: m[1] });
    m = remaining.match(/(?<!\*)\*([^*]+)\*(?!\*)|(?<!_)_([^_]+)_(?!_)/);
    if (m) {
      const c = m[1] || m[2];
      if (c) matches.push({ type: "italic", index: m.index, length: m[0].length, content: c });
    }
    if (matches.length === 0) { segments.push({ type: "text", content: remaining }); break; }
    matches.sort((a, b) => a.index - b.index);
    const fm = matches[0];
    if (fm.index > 0) segments.push({ type: "text", content: remaining.slice(0, fm.index) });
    segments.push({ type: fm.type, content: fm.content, text: fm.text, url: fm.url });
    remaining = remaining.slice(fm.index + fm.length);
  }
  return segments;
}
