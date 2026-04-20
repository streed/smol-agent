#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const srcRoot = path.join(repoRoot, "src");
const distRoot = path.join(repoRoot, "dist");

async function copyJavaScriptFiles(sourceDir) {
  const entries = await fs.readdir(sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    const sourcePath = path.join(sourceDir, entry.name);
    const relativePath = path.relative(srcRoot, sourcePath);
    const targetPath = path.join(distRoot, relativePath);

    if (entry.isDirectory()) {
      await copyJavaScriptFiles(sourcePath);
      continue;
    }

    if (!entry.isFile() || !entry.name.endsWith(".js")) {
      continue;
    }

    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.copyFile(sourcePath, targetPath);
  }
}

await copyJavaScriptFiles(srcRoot);
await fs.chmod(path.join(distRoot, "index.js"), 0o755);
