import fs from "node:fs/promises";
import { register } from "./registry.js";
import { refreshProjectMap } from "../context.js";

register("delete_file", {
  description:
    "Delete a file at the given path. Use ask_user to confirm before deleting unless the user has explicitly asked for the deletion.",
  parameters: {
    type: "object",
    required: ["path"],
    properties: {
      path: {
        type: "string",
        description: "Absolute or relative path to the file to delete.",
      },
    },
  },
  async execute({ path }) {
    await fs.unlink(path);
    // Refresh the project map so the cache no longer lists the deleted file.
    refreshProjectMap(process.cwd());
    return { status: "ok", path };
  },
});
