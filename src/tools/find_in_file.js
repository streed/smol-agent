import fs from "node:fs/promises";
import { register } from "./registry.js";
import { resolveJailedPath } from "../path-utils.js";

register("find_in_file", {
  description:
    "Find specific text within a file and return the line numbers and content where it appears. Useful for locating where to make edits.",
  parameters: {
    type: "object",
    required: ["path", "search_text"],
    properties: {
      path: {
        type: "string",
        description: "Path to the file to search in.",
      },
      search_text: {
        type: "string",
        description: "The text to search for in the file.",
      },
      case_sensitive: {
        type: "boolean",
        description: "Whether the search should be case sensitive (default: true).",
      },
    },
  },
  async execute({ path: filePath, search_text, case_sensitive = true }) {
    try {
      // Resolve the path relative to the current working directory (which should be the jail directory)
      const resolvedPath = resolveJailedPath(process.cwd(), filePath);
      
      const content = await fs.readFile(resolvedPath, "utf-8");
      const lines = content.split("\n");
      const matches = [];
      
      // Create the regex with appropriate flags
      const flags = case_sensitive ? "g" : "gi";
      const escapedText = search_text.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&");
      const regex = new RegExp(escapedText, flags);
      
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (regex.test(line)) {
          matches.push({
            line_number: i + 1,
            content: line
          });
        }
      }
      
      return { 
        matches,
        total_matches: matches.length
      };
    } catch (err) {
      return { error: `Failed to read file ${filePath}: ${err.message}` };
    }
  },
});