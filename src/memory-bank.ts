/**
 * Memory Bank — inspired by Kilocode's structured cross-session knowledge system.
 *
 * Maintains a set of markdown files in .smol-agent/memory-bank/ that persist
 * across sessions. Unlike the simple key-value memory tool, the Memory Bank
 * provides structured context about the project:
 *
 *   - projectContext.md  — What the project does, key goals, tech stack
 *   - techContext.md     — Architecture decisions, patterns, conventions
 *   - progress.md        — Current status, recent changes, known issues
 *   - learnings.md       — What worked, what didn't, lessons learned
 *
 * The agent can read all bank files at session start and update them as it
 * learns about the project.
 *
 * Key exports:
 *   - initMemoryBank(cwd): Create memory-bank directory with templates
 *   - loadMemoryBank(cwd): Load all bank files into structured object
 *   - readMemoryBankSection(cwd, section): Read a single section
 *   - writeMemoryBankSection(cwd, section, content): Update a section
 *
 * Dependencies: node:fs/promises, node:fs, node:path, ./logger.js
 * Depended on by: src/context.js, src/tools/memory.js, test/unit/memory-bank.test.js
 */

import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { logger } from "./logger.js";

const MEMORY_BANK_DIR = ".smol-agent/memory-bank";

interface BankFileConfig {
  filename: string;
  template: string;
}

const BANK_FILES: Record<string, BankFileConfig> = {
  projectContext: {
    filename: "projectContext.md",
    template: `# Project Context

## Overview
<!-- What does this project do? What problem does it solve? -->

## Tech Stack
<!-- Languages, frameworks, key dependencies -->

## Key Goals
<!-- Primary objectives and success criteria -->
`,
  },
  techContext: {
    filename: "techContext.md",
    template: `# Technical Context

## Architecture
<!-- High-level architecture, main modules, data flow -->

## Patterns & Conventions
<!-- Coding style, naming conventions, patterns used -->

## Key Files
<!-- Important files and what they contain -->
`,
  },
  progress: {
    filename: "progress.md",
    template: `# Progress

## Current Status
<!-- What's the current state of the project? -->

## Recent Changes
<!-- What was recently added/modified? -->

## Known Issues
<!-- Current bugs, limitations, tech debt -->
`,
  },
  learnings: {
    filename: "learnings.md",
    template: `# Learnings

## What Worked
<!-- Successful approaches, good decisions -->

## What Didn't Work
<!-- Failed approaches, things to avoid -->

## Important Notes
<!-- Key insights, gotchas, things to remember -->
`,
  },
};

/**
 * Ensure the memory bank directory exists.
 */
async function ensureBankDir(cwd: string): Promise<string> {
  const bankPath = path.join(cwd, MEMORY_BANK_DIR);
  await fs.mkdir(bankPath, { recursive: true });
  return bankPath;
}

/**
 * Read a specific memory bank file.
 *
 * @param cwd - Project root
 * @param bankKey - One of: projectContext, techContext, progress, learnings
 * @returns File content or null if not found
 */
export async function readBankFile(cwd: string, bankKey: string): Promise<string | null> {
  const config = BANK_FILES[bankKey];
  if (!config) return null;

  const filePath = path.join(cwd, MEMORY_BANK_DIR, config.filename);
  try {
    return await fs.readFile(filePath, "utf-8");
  } catch {
    return null;
  }
}

/**
 * Write/update a memory bank file.
 *
 * @param cwd - Project root
 * @param bankKey - One of: projectContext, techContext, progress, learnings
 * @param content - New content for the file
 */
export async function writeBankFile(cwd: string, bankKey: string, content: string): Promise<void> {
  const config = BANK_FILES[bankKey];
  if (!config) throw new Error(`Unknown bank file: ${bankKey}`);

  const bankPath = await ensureBankDir(cwd);
  const filePath = path.join(bankPath, config.filename);
  await fs.writeFile(filePath, content, "utf-8");
  logger.info(`Memory bank updated: ${config.filename}`);
}

/**
 * Initialize memory bank with templates for any missing files.
 *
 * @param cwd - Project root
 */
export async function initializeBank(cwd: string): Promise<void> {
  const bankPath = await ensureBankDir(cwd);

  for (const [_key, config] of Object.entries(BANK_FILES)) {
    const filePath = path.join(bankPath, config.filename);
    if (!fsSync.existsSync(filePath)) {
      await fs.writeFile(filePath, config.template, "utf-8");
      logger.debug(`Memory bank initialized: ${config.filename}`);
    }
  }
}

/**
 * Load all memory bank files and return as a formatted context string.
 * Used for injecting into the system prompt at session start.
 *
 * @param cwd - Project root
 * @returns Formatted memory bank content, or null if empty
 */
export async function loadMemoryBank(cwd: string): Promise<string | null> {
  const bankPath = path.join(cwd, MEMORY_BANK_DIR);

  if (!fsSync.existsSync(bankPath)) return null;

  const sections: string[] = [];

  for (const [_key, config] of Object.entries(BANK_FILES)) {
    const filePath = path.join(bankPath, config.filename);
    try {
      const content = await fs.readFile(filePath, "utf-8");
      // Skip files that are just templates (no user content)
      const stripped = content.replace(/<!--.*?-->/gs, "").replace(/^#.*$/gm, "").trim();
      if (stripped.length > 10) {
        sections.push(content.trim());
      }
    } catch {
      // File doesn't exist yet
    }
  }

  if (sections.length === 0) return null;

  return `## Memory Bank (persistent cross-session knowledge)\n\n${sections.join("\n\n---\n\n")}`;
}

/**
 * Get available bank file keys.
 */
export function getBankFileKeys(): string[] {
  return Object.keys(BANK_FILES);
}

/**
 * Get the template for a bank file.
 */
export function getBankTemplate(bankKey: string): string | null {
  return BANK_FILES[bankKey]?.template || null;
}