/**
 * Memory tools for persistent key-value storage.
 *
 * Two types of memory:
 *   - Simple key-value: .smol-agent/memory.json (remember, recall)
 *   - Structured Memory Bank: .smol-agent/memory-bank/*.md (projectContext, techContext, etc.)
 *
 * Simple memory is for ad-hoc facts and preferences. The Memory Bank is for
 * structured cross-session knowledge about the project.
 *
 * Key exports:
 *   - loadMemories(cwd): Load simple key-value memories
 *   - Tool registrations: remember, recall, memory_bank_init, memory_bank_read,
 *                        memory_bank_write, save_context
 *
 * @file-doc
 * @module tools/memory
 * @dependencies ./registry.js, node:fs/promises, node:path, ../path-utils.js, ../memory-bank.js
 * @dependents src/agent.js, src/constants.js, src/context.js, src/memory-bank.js,
 *             src/tools/discover_tools.js, src/tools/registry.js,
 *             test/e2e/scenarios/38-add-error-handling.test.js,
 *             test/e2e/scenarios/41-cpp-fix-memory-bug.test.js,
 *             test/e2e/scenarios/50-memory-tool.test.js,
 *             test/e2e/scenarios/54-auto-discovery-context.test.js,
 *             test/unit/memory-bank.test.js, test/unit/registry.test.js
 */
import { register } from "./registry.js";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveJailedPath } from "../path-utils.js";
import { readBankFile, writeBankFile, initializeBank, getBankFileKeys, loadMemoryBank } from "../memory-bank.js";

const MEMORY_DIR = ".smol-agent";
const MEMORY_FILE = "memory.json";

interface MemoryEntry {
  value: string;
  category: string;
  savedAt: string;
}

interface Memories {
  [key: string]: MemoryEntry;
}

interface RememberArgs {
  key: string;
  value: string;
  category?: string;
}

interface RememberResult {
  success?: boolean;
  message?: string;
}

interface RecallArgs {
  key?: string;
}

interface RecallResult {
  count?: number;
  memories?: Memories;
  message?: string;
  error?: string;
  value?: string;
  category?: string;
  savedAt?: string;
}

interface MemoryBankReadArgs {
  section?: string;
}

interface MemoryBankReadResult {
  section?: string;
  content?: string;
  message?: string;
  error?: string;
}

interface MemoryBankWriteArgs {
  section: string;
  content: string;
}

interface MemoryBankWriteResult {
  success?: boolean;
  message?: string;
  error?: string;
}

interface MemoryBankInitResult {
  success?: boolean;
  message?: string;
  sections?: string[];
}

/**
 * Load persistent memories from disk.
 * Exported for use in context.js to inject memories into system prompt.
 */
export async function loadMemories(cwd: string): Promise<Memories> {
  try {
    const dirPath = resolveJailedPath(cwd, MEMORY_DIR);
    const filepath = path.join(dirPath, MEMORY_FILE);
    const data = await fs.readFile(filepath, "utf-8");
    return JSON.parse(data) as Memories;
  } catch {
    return {};
  }
}

async function saveMemories(cwd: string, memories: Memories): Promise<void> {
  const dirPath = resolveJailedPath(cwd, MEMORY_DIR);
  await fs.mkdir(dirPath, { recursive: true });
  const filepath = path.join(dirPath, MEMORY_FILE);
  await fs.writeFile(filepath, JSON.stringify(memories, null, 2), "utf-8");
}

register("remember", {
  description:
    "Save a fact, pattern, or preference to persistent memory. Persists across sessions. Use to remember project conventions, successful strategies, user preferences, test commands, etc.",
  parameters: {
    type: "object",
    properties: {
      key: {
        type: "string",
        description:
          "Short key for the memory (e.g. 'test_command', 'coding_style', 'db_schema')",
      },
      value: {
        type: "string",
        description: "The information to remember",
      },
      category: {
        type: "string",
        description:
          "Category: project, preference, pattern, or learned",
      },
    },
    required: ["key", "value"],
  },
  async execute({ key, value, category }: RememberArgs, { cwd = process.cwd() } = {}): Promise<RememberResult> {
    const memories = await loadMemories(cwd);
    memories[key] = {
      value,
      category: category || "general",
      savedAt: new Date().toISOString(),
    };
    await saveMemories(cwd, memories);
    return { success: true, message: `Remembered "${key}": ${value}` };
  },
});

register("recall", {
  description:
    "Retrieve memories from persistent storage. Omit key to get all memories.",
  parameters: {
    type: "object",
    properties: {
      key: {
        type: "string",
        description: "Specific key to recall, or omit for all",
      },
    },
  },
  async execute({ key }: RecallArgs, { cwd = process.cwd() } = {}): Promise<RecallResult> {
    const memories = await loadMemories(cwd);
    if (key) {
      return memories[key] || { error: `No memory for "${key}"` };
    }
    const count = Object.keys(memories).length;
    if (count === 0) return { message: "No memories stored yet." };
    return { count, memories };
  },
});

// ── Memory Bank (Kilocode-inspired structured knowledge) ─────────────

register("memory_bank_read", {
  description:
    "Read a Memory Bank file. The Memory Bank stores structured cross-session knowledge about the project in markdown files: projectContext (what the project does), techContext (architecture/patterns), progress (current status), learnings (what worked/didn't).",
  parameters: {
    type: "object",
    properties: {
      section: {
        type: "string",
        description: "Which section to read: projectContext, techContext, progress, or learnings. Omit to read all.",
      },
    },
  },
  async execute({ section }: MemoryBankReadArgs, { cwd = process.cwd() } = {}): Promise<MemoryBankReadResult> {
    if (section) {
      const validKeys = getBankFileKeys();
      if (!validKeys.includes(section)) {
        return { error: `Unknown section: ${section}. Valid: ${validKeys.join(", ")}` };
      }
      const content = await readBankFile(cwd, section);
      if (!content) {
        return { message: `No ${section} file found. Use memory_bank_write to create it.` };
      }
      return { section, content };
    }

    // Read all sections
    const bank = await loadMemoryBank(cwd);
    if (!bank) {
      return { message: "Memory Bank is empty. Use memory_bank_write to add project knowledge." };
    }
    return { content: bank };
  },
});

register("memory_bank_write", {
  description:
    "Write to a Memory Bank file. Use to store structured project knowledge that persists across sessions. Sections: projectContext (what the project does, tech stack), techContext (architecture, patterns, conventions), progress (current status, recent changes), learnings (what worked, what didn't).",
  parameters: {
    type: "object",
    required: ["section", "content"],
    properties: {
      section: {
        type: "string",
        description: "Section to write: projectContext, techContext, progress, or learnings",
      },
      content: {
        type: "string",
        description: "Markdown content for the section",
      },
    },
  },
  async execute({ section, content }: MemoryBankWriteArgs, { cwd = process.cwd() } = {}): Promise<MemoryBankWriteResult> {
    const validKeys = getBankFileKeys();
    if (!validKeys.includes(section)) {
      return { error: `Unknown section: ${section}. Valid: ${validKeys.join(", ")}` };
    }
    await writeBankFile(cwd, section, content);
    return { success: true, message: `Memory Bank "${section}" updated (${content.length} chars)` };
  },
});

register("memory_bank_init", {
  description:
    "Initialize the Memory Bank with template files. Creates .smol-agent/memory-bank/ with structured markdown templates. Run this at the start of a new project.",
  parameters: {
    type: "object",
    properties: {},
  },
  async execute(_args: Record<string, never>, { cwd = process.cwd() } = {}): Promise<MemoryBankInitResult> {
    await initializeBank(cwd);
    return {
      success: true,
      message: "Memory Bank initialized with template files",
      sections: getBankFileKeys(),
    };
  },
});