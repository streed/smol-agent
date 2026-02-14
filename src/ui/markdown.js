import React from "react";
import { Text, Box } from "ink";

const e = React.createElement;

/**
 * Enhanced markdown renderer for terminal output
 * Converts markdown-style text to styled Text components
 */
export function Markdown({ children }) {
  if (!children) return null;
  
  return e(
    Box,
    { flexDirection: "column" },
    ...processMarkdown(children)
  );
}

function processMarkdown(text) {
  if (!text) return [];
  
  // Split by double newlines for paragraphs
  const paragraphs = text.split('\n\n');
  const elements = [];
  
  for (let i = 0; i < paragraphs.length; i++) {
    const paragraph = paragraphs[i];
    if (!paragraph.trim()) continue;
    
    // Handle code blocks (```...```)
    if (paragraph.startsWith('```') && paragraph.endsWith('```')) {
      const codeContent = paragraph.slice(3, -3).trim();
      const lines = codeContent.split('\n');
      elements.push(
        e(
          Box,
          { key: i, marginTop: 1, marginBottom: 1, flexDirection: "column" },
          ...lines.map((line, j) => 
            e(Text, { key: j, color: "gray" }, line)
          )
        )
      );
    }
    // Handle fenced code blocks with language (```js\n...\n```)
    else if (paragraph.startsWith('```')) {
      const lines = paragraph.split('\n');
      const codeLines = lines.slice(1, -1);
      elements.push(
        e(
          Box,
          { key: i, marginTop: 1, marginBottom: 1, flexDirection: "column" },
          ...codeLines.map((line, j) => 
            e(Text, { key: j, color: "gray" }, line)
          )
        )
      );
    }
    // Handle blockquotes (> quote)
    else if (paragraph.startsWith('> ')) {
      const quoteLines = paragraph.split('\n').map(line => line.startsWith('> ') ? line.slice(2) : line);
      elements.push(
        e(
          Box,
          { key: i, marginTop: 1, marginBottom: 1, flexDirection: "column" },
          ...quoteLines.map((line, j) => 
            e(Text, { key: j, color: "gray", italic: true }, line)
          )
        )
      );
    }
    // Handle headers (# Header, ## Header, ### Header)
    else if (/^#{1,3}\s/.test(paragraph)) {
      const match = paragraph.match(/^(#{1,3})\s+(.*)/);
      if (match) {
        const level = match[1].length;
        const content = match[2];
        
        let color = "cyan";
        if (level === 2) color = "yellow";
        if (level === 3) color = "magenta";
        
        elements.push(
          e(
            Box, 
            { key: i, marginTop: level === 1 ? 1 : 0, marginBottom: 1 },
            e(Text, { bold: true, color }, content)
          )
        );
      } else {
        // Fallback to regular paragraph
        const lines = paragraph.split('\n');
        elements.push(
          e(
            Box,
            { key: i, marginTop: 0, marginBottom: 1, flexDirection: "column" },
            ...lines.map((line, j) =>
              e(
                Box,
                { key: j },
                ...processInlineFormatting(line)
              )
            )
          )
        );
      }
    }
    // Handle horizontal rules
    else if (/^(-{3,}|_{3,}|\*{3,})$/.test(paragraph)) {
      elements.push(
        e(Box, { key: i },
          e(Text, { dimColor: true }, "─".repeat(20))
        )
      );
    }
    // Handle unordered lists (- item or * item)
    else if (/^(\s*)(-|\*)\s/.test(paragraph)) {
      const listItems = paragraph.split('\n');
      elements.push(
        e(
          Box,
          { key: i, marginTop: 1, marginBottom: 1, flexDirection: "column" },
          ...listItems.map((item, j) => {
            const match = item.match(/^(\s*)(-|\*)\s+(.*)$/);
            if (match) {
              const indent = match[1].length;
              const content = match[3];
              return e(
                Box,
                { key: j, marginLeft: indent },
                e(Text, null, "• "),
                ...processInlineFormatting(content)
              );
            }
            return e(Box, { key: j }, e(Text, null, item));
          })
        )
      );
    }
    // Handle ordered lists (1. item)
    else if (/^(\s*)\d+\.\s/.test(paragraph)) {
      const listItems = paragraph.split('\n');
      elements.push(
        e(
          Box,
          { key: i, marginTop: 1, marginBottom: 1, flexDirection: "column" },
          ...listItems.map((item, j) => {
            const match = item.match(/^(\s*)(\d+)\.\s+(.*)$/);
            if (match) {
              const indent = match[1].length;
              const number = match[2];
              const content = match[3];
              return e(
                Box,
                { key: j, marginLeft: indent },
                e(Text, null, `${number}. `),
                ...processInlineFormatting(content)
              );
            }
            return e(Box, { key: j }, e(Text, null, item));
          })
        )
      );
    }
    // Handle regular paragraphs with inline formatting
    else {
      // Split by single newlines to handle line breaks within paragraphs
      const lines = paragraph.split('\n');
      elements.push(
        e(
          Box,
          { key: i, marginTop: 0, marginBottom: 1, flexDirection: "column" },
          ...lines.map((line, j) =>
            e(
              Box,
              { key: j },
              ...processInlineFormatting(line)
            )
          )
        )
      );
    }
  }
  
  return elements;
}

function processInlineFormatting(text) {
  if (!text) return [];
  
  const elements = [];
  let remaining = text;
  
  // Process links, bold, italic, inline code in order
  while (remaining.length > 0) {
    // Find the next special pattern
    const patterns = [
      { regex: /\[([^\]]+)\]\(([^)]+)\)/, type: 'link' },
      { regex: /\*\*([^*]+)\*\*/, type: 'bold' },
      { regex: /`([^`]+)`/, type: 'code' },
      { regex: /\*([^*]+)\*/, type: 'italic' },
      { regex: /_([^_]+)_/, type: 'italic' },
    ];
    
    let earliestMatch = null;
    let earliestIndex = remaining.length;
    let matchType = null;
    
    for (const { regex, type } of patterns) {
      regex.lastIndex = 0;
      const match = regex.exec(remaining);
      if (match && match.index < earliestIndex) {
        earliestIndex = match.index;
        earliestMatch = match;
        matchType = type;
      }
    }
    
    if (earliestMatch) {
      // Add text before the match
      if (earliestIndex > 0) {
        elements.push(e(Text, { key: elements.length }, remaining.slice(0, earliestIndex)));
      }
      
      // Add the matched element
      if (matchType === 'link') {
        elements.push(e(Text, { key: elements.length, color: "blue", underline: true }, earliestMatch[1]));
        elements.push(e(Text, { key: elements.length }, ` (${earliestMatch[2]})`));
      } else if (matchType === 'bold') {
        elements.push(e(Text, { key: elements.length, bold: true }, earliestMatch[1]));
      } else if (matchType === 'code') {
        elements.push(e(Text, { key: elements.length, color: "cyan" }, earliestMatch[1]));
      } else if (matchType === 'italic') {
        elements.push(e(Text, { key: elements.length, italic: true }, earliestMatch[1]));
      }
      
      // Move past the match
      remaining = remaining.slice(earliestIndex + earliestMatch[0].length);
    } else {
      // No more special patterns, add the rest as plain text
      elements.push(e(Text, { key: elements.length }, remaining));
      break;
    }
  }
  
  return elements;
}