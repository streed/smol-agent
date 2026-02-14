import fs from "node:fs/promises";
import path from "node:path";
import { register } from "./registry.js";
import { resolveJailedPath } from "../path-utils.js";

register("write_file", {
  description:
    "Write content to a file, creating it (and parent directories) if it does not exist, or overwriting it if it does.",
  parameters: {
    type: "object",
    required: ["path", "content"],
    properties: {
      path: {
        type: "string",
        description: "Absolute or relative path to the file to write.",
      },
      content: {
        type: "string",
        description: "The full content to write to the file.",
      },
    },
  },
  async execute({ path: filePath, content }) {
    // Resolve the path relative to the current working directory (which should be the jail directory)
    const resolvedPath = resolveJailedPath(process.cwd(), filePath);
    
    await fs.mkdir(path.dirname(resolvedPath), { recursive: true });
    await fs.writeFile(resolvedPath, content, "utf-8");
    return { status: "ok", path: resolvedPath, bytes: Buffer.byteLength(content) };
  },
});
