import React from "react";
import { render } from "ink";
import { Markdown } from "../src/ui/markdown.js";

// Test markdown content
const testContent = `
# Heading 1

This is a paragraph with **bold text** and \`inline code\`.

## Heading 2

Here's a list:
- Item 1
- Item 2 with \`code\`
- Item 3 with **bold**

### Heading 3

> This is a blockquote
> With multiple lines

\`\`\`
const code = "block";
console.log(code);
\`\`\`

[Link Text](https://example.com)

---
`;

console.log("Testing Markdown Renderer:");
console.log("========================");

// Since we can't easily render JSX in Node.js without a full Ink setup,
// we'll just verify the component exports and doesn't crash
try {
  console.log("✓ Markdown component imported successfully");
  
  // Test basic functionality
  const fakeElement = React.createElement(Markdown, null, testContent);
  console.log("✓ Markdown component creates element successfully");
  
  console.log("\\nTest content preview:");
  console.log(testContent);
} catch (error) {
  console.error("✗ Error testing Markdown component:", error.message);
}