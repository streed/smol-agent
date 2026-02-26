import React from "react";
import { Text, Box } from "ink";

const e = React.createElement;

export function Markdown({ children }) {
  if (!children) return null;
  return e(Box, { flexDirection: "column" }, ...processMarkdown(children));
}

function processMarkdown(text) {
  if (!text) return [];
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const elements = [];
  let i = 0;
  
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    
    if (line.startsWith('```') || line.startsWith('~~~')) {
      const fenceChar = line.slice(0, 3);
      const language = line.slice(3).trim() || '';
      const codeLines = [];
      i++;
      while (i < lines.length && !lines[i].startsWith(fenceChar)) {
        codeLines.push(lines[i]);
        i++;
      }
      const codeBox = [e(Text, { key: "lang", color: "magenta", dimColor: true }, language)];
      codeLines.forEach((c, j) => codeBox.push(e(Text, { key: j, color: "gray" }, c)));
      elements.push(e(Box, { key: elements.length, marginTop: 1, marginBottom: 1, flexDirection: "column", borderStyle: "round", borderColor: "gray", paddingX: 1 }, ...codeBox));
      i++;
      continue;
    }
    
    const headerMatch = line.match(/^(#{1,6})\s+(.*)$/);
    if (headerMatch) {
      const level = headerMatch[1].length;
      const content = headerMatch[2].replace(/\s+#+$/, '').trim();
      const colors = ['cyan', 'green', 'yellow', 'magenta', 'blue', 'gray'];
      elements.push(e(Box, { key: elements.length, marginTop: level === 1 ? 1 : 0, marginBottom: 1 }, e(Text, { bold: true, color: colors[Math.min(level - 1, 5)] }, content)));
      i++;
      continue;
    }
    
    if (/^(-{3,}|_{3,}|\*{3,})$/.test(line.trim())) {
      elements.push(e(Box, { key: elements.length, marginTop: 1, marginBottom: 1 }, e(Text, { dimColor: true }, "─".repeat(40))));
      i++;
      continue;
    }
    
    if (line.startsWith('>')) {
      const quoteLines = [];
      while (i < lines.length && (lines[i].startsWith('>') || !lines[i].trim())) {
        const q = lines[i].replace(/^>\s*/, '');
        if (q.trim()) quoteLines.push(q);
        i++;
      }
      if (quoteLines.length > 0) {
        const qbox = [];
        quoteLines.forEach((q, j) => qbox.push(e(Text, { key: j, color: "gray", italic: true }, q)));
        elements.push(e(Box, { key: elements.length, marginTop: 1, marginBottom: 1, flexDirection: "column", borderStyle: "round", borderColor: "gray", paddingX: 1 }, ...qbox));
      }
      continue;
    }
    
    const taskMatch = line.match(/^(\s*)[-*]\s+\[([ xX])\]\s+(.*)$/);
    if (taskMatch) {
      const indent = taskMatch[1].length;
      const checked = taskMatch[2].toLowerCase() === 'x';
      const content = taskMatch[3];
      const inline = processInlineFormatting(content);
      elements.push(e(Box, { key: elements.length, marginLeft: indent }, e(Text, { color: checked ? "green" : "gray" }, checked ? "☑" : "☐"), e(Text, { marginLeft: 1 }, ...inline)));
      i++;
      continue;
    }
    
    if (/^(\s*)[-*]\s+/.test(line)) {
      const listItems = [];
      while (i < lines.length) {
        const m = lines[i].match(/^(\s*)[-*]\s+(.*)$/);
        if (!m) break;
        listItems.push({ indent: m[1].length, content: m[2] });
        i++;
      }
      const lbox = [];
      listItems.forEach((item, j) => {
        const inline = processInlineFormatting(item.content);
        lbox.push(e(Box, { key: j, marginLeft: item.indent }, e(Text, { color: "cyan" }, "• "), e(Text, null, ...inline)));
      });
      elements.push(e(Box, { key: elements.length, marginTop: 1, marginBottom: 1, flexDirection: "column" }, ...lbox));
      continue;
    }
    
    if (/^(\s*)\d+\.\s+/.test(line)) {
      const listItems = [];
      while (i < lines.length) {
        const m = lines[i].match(/^(\s*)(\d+)\.\s+(.*)$/);
        if (!m) break;
        listItems.push({ indent: m[1].length, number: m[2], content: m[3] });
        i++;
      }
      const lbox = [];
      listItems.forEach((item, j) => {
        const inline = processInlineFormatting(item.content);
        lbox.push(e(Box, { key: j, marginLeft: item.indent }, e(Text, { color: "cyan" }, item.number + ". "), e(Text, null, ...inline)));
      });
      elements.push(e(Box, { key: elements.length, marginTop: 1, marginBottom: 1, flexDirection: "column" }, ...lbox));
      continue;
    }
    
    if (line.match(/^\|.+\|$/) && i + 1 < lines.length && lines[i + 1].match(/^\|[\s-:]+\|$/)) {
      const tableLines = [line];
      i++;
      if (i < lines.length && lines[i].match(/^\|[\s-:]+\|$/)) {
        tableLines.push(lines[i]);
        i++;
      }
      while (i < lines.length && lines[i].match(/^\|.+\|$/)) {
        tableLines.push(lines[i]);
        i++;
      }
      elements.push(renderTable(tableLines, elements.length));
      continue;
    }
    
    // Paragraph handling - trim leading whitespace from each line
    const paragraphLines = [];
    while (i < lines.length && lines[i].trim()) {
      const l = lines[i];
      if (l.startsWith('```') || l.startsWith('~~~') || l.match(/^#{1,6}\s/) || l.match(/^(\s*)[-*]\s+/) || l.match(/^(\s*)\d+\.\s+/) || l.match(/^\|.+\|$/) || l.match(/^[-_]{3,}$/) || l.startsWith('>')) break;
      // Trim leading whitespace to handle indented paragraphs
      paragraphLines.push(l.trim());
      i++;
    }
    
    if (paragraphLines.length > 0) {
      const pbox = [];
      paragraphLines.forEach((p, j) => pbox.push(e(Box, { key: j }, ...processInlineFormatting(p))));
      elements.push(e(Box, { key: elements.length, marginTop: 0, marginBottom: 1, flexDirection: "column" }, ...pbox));
    }
  }
  return elements;
}

function renderTable(tableLines, key) {
  const headers = tableLines[0].split('|').slice(1, -1).map(h => h.trim());
  const dataRows = tableLines.slice(2).map(row => row.split('|').slice(1, -1).map(cell => cell.trim()));
  const colWidths = headers.map((h, i) => Math.min(Math.max(h.length, ...dataRows.map(r => (r[i] || '').length)), 30));
  const rows = [];
  const hrow = [];
  headers.forEach((h, i) => hrow.push(e(Text, { key: i, bold: true, color: "cyan", width: colWidths[i] }, h.padEnd(colWidths[i]))));
  rows.push(e(Box, { key: "header" }, ...hrow));
  const srow = [];
  colWidths.forEach((w, i) => srow.push(e(Text, { key: i, dimColor: true }, "─".repeat(w + 2))));
  rows.push(e(Box, { key: "sep" }, ...srow));
  dataRows.forEach((row, idx) => {
    const rbox = [];
    row.forEach((c, i) => rbox.push(e(Text, { key: i, width: colWidths[i] }, (c || '').padEnd(colWidths[i]))));
    rows.push(e(Box, { key: "row-" + idx }, ...rbox));
  });
  return e(Box, { key: key, marginTop: 1, marginBottom: 1, flexDirection: "column" }, ...rows);
}

function processInlineFormatting(text) {
  if (!text) return [e(Text, null, "")];
  // First, normalize whitespace: collapse multiple spaces into single space
  const normalized = text.replace(/\s+/g, ' ').trim();
  const segments = splitIntoSegments(normalized);
  const elements = [];
  segments.forEach((seg, idx) => {
    if (seg.type === 'text') elements.push(e(Text, { key: idx }, seg.content));
    else if (seg.type === 'bold') elements.push(e(Text, { key: idx, bold: true }, seg.content));
    else if (seg.type === 'italic') elements.push(e(Text, { key: idx, italic: true }, seg.content));
    else if (seg.type === 'boldItalic') elements.push(e(Text, { key: idx, bold: true, italic: true }, seg.content));
    else if (seg.type === 'code') elements.push(e(Text, { key: idx, color: "cyan", bold: true }, seg.content));
    else if (seg.type === 'link') { elements.push(e(Text, { key: idx, color: "blue", underline: true }, seg.text)); elements.push(e(Text, { key: idx + '_url', dimColor: true }, " (" + seg.url + ")")); }
    else if (seg.type === 'strikethrough') elements.push(e(Text, { key: idx, strikethrough: true, dimColor: true }, seg.content));
    else elements.push(e(Text, { key: idx }, seg.content));
  });
  return elements;
}

function splitIntoSegments(text) {
  const segments = [];
  let remaining = text;
  while (remaining.length > 0) {
    const matches = [];
    let m = remaining.match(/\[([^\]]+)\]\(([^)]+)\)/); if (m) matches.push({ type: 'link', index: m.index, length: m[0].length, text: m[1], url: m[2] });
    m = remaining.match(/\*\*\*([^*]+)\*\*\*/); if (m) matches.push({ type: 'boldItalic', index: m.index, length: m[0].length, content: m[1] });
    m = remaining.match(/\*\*([^*]+)\*\*/); if (m) matches.push({ type: 'bold', index: m.index, length: m[0].length, content: m[1] });
    m = remaining.match(/~~([^~]+)~~/); if (m) matches.push({ type: 'strikethrough', index: m.index, length: m[0].length, content: m[1] });
    m = remaining.match(/`([^`]+)`/); if (m) matches.push({ type: 'code', index: m.index, length: m[0].length, content: m[1] });
    m = remaining.match(/(?<!\*)\*([^*]+)\*(?!\*)|(?<!_)_([^_]+)_(?!_)/); if (m) { const isA = m[0].startsWith('*'); const c = isA ? m[1] : m[2]; if (c) matches.push({ type: 'italic', index: m.index, length: m[0].length, content: c }); }
    if (matches.length === 0) { segments.push({ type: 'text', content: remaining }); break; }
    matches.sort((a, b) => a.index - b.index);
    const fm = matches[0];
    if (fm.index > 0) segments.push({ type: 'text', content: remaining.slice(0, fm.index) });
    segments.push({ type: fm.type, content: fm.content, text: fm.text, url: fm.url });
    remaining = remaining.slice(fm.index + fm.length);
  }
  return segments;
}
