import fs from "node:fs/promises";
import path from "node:path";
import { register } from "./registry.js";
import { refreshProjectMap } from "../context.js";

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
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content, "utf-8");
    // Refresh the project map so the cache reflects the new file.
    refreshProjectMap(process.cwd());
    return { status: "ok", path: filePath, bytes: Buffer.byteLength(content) };
  },
});
