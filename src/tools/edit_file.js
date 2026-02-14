import fs from "node:fs/promises";
import { register } from "./registry.js";
import { resolveJailedPath } from "../path-utils.js";

register("edit_file", {
  description:
    "Perform a find-and-replace edit in a file. Finds the first occurrence of `old_string` and replaces it with `new_string`. The old_string must match exactly (including whitespace/indentation). Use find_in_file to locate the exact text to replace.",
  parameters: {
    type: "object",
    required: ["path", "old_string", "new_string"],
    properties: {
      path: {
        type: "string",
        description: "Path to the file to edit.",
      },
      old_string: {
        type: "string",
        description:
          "The exact string to find in the file. Must match file content exactly including whitespace.",
      },
      new_string: {
        type: "string",
        description: "The replacement string.",
      },
    },
  },
  async execute({ path: filePath, old_string, new_string }) {
    // Resolve the path relative to the current working directory (which should be the jail directory)
    const resolvedPath = resolveJailedPath(process.cwd(), filePath);
    
    const content = await fs.readFile(resolvedPath, "utf-8");
    if (!content.includes(old_string)) {
      return {
        error: `String not found in ${resolvedPath}. Use find_in_file to locate the exact text, or read the file to verify current content.`,
      };
    }
    const updated = content.replace(old_string, new_string);
    await fs.writeFile(resolvedPath, updated, "utf-8");
    return { status: "ok", path: resolvedPath, replaced: true };
  },
});
