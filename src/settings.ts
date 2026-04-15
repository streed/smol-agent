import fs from "node:fs/promises";
import path from "node:path";

const SETTINGS_DIR = ".smol-agent";
const SETTINGS_FILE = "settings.json";

interface SettingsDefaults {
  autoApprove: boolean;
  approvedCategories: string[];
}

const DEFAULTS: SettingsDefaults = {
  autoApprove: false,
  approvedCategories: [],
};

// Security-sensitive keys that cannot be set via the settings file.
// These can only be set via CLI flags to prevent prompt-injection attacks
// where an LLM writes to .smol-agent/settings.json.
// Note: approvedCategories is NOT here because per-category approvals are granular
// and less dangerous than the blanket autoApprove flag.
const CLI_ONLY_KEYS = new Set(["autoApprove"]);

export interface Settings extends SettingsDefaults {
  [key: string]: unknown;
}

/**
 * Load settings from .smol-agent/settings.json in the given directory.
 * Returns defaults for any missing keys.
 * Security-sensitive keys (autoApprove) are stripped — they can only be set via CLI.
 */
export async function loadSettings(cwd: string): Promise<Settings> {
  try {
    const filepath = path.join(cwd, SETTINGS_DIR, SETTINGS_FILE);
    const data = await fs.readFile(filepath, "utf-8");
    const parsed = JSON.parse(data) as Record<string, unknown>;
    // Strip security-sensitive keys — only CLI flags can set these
    for (const key of CLI_ONLY_KEYS) {
      delete parsed[key];
    }
    return { ...DEFAULTS, ...parsed } as Settings;
  } catch {
    return { ...DEFAULTS };
  }
}

/**
 * Save settings to .smol-agent/settings.json in the given directory.
 * Merges with existing settings.
 * Security-sensitive keys (autoApprove) are blocked — can only be set via CLI.
 */
export async function saveSettings(cwd: string, settings: Partial<Settings>): Promise<Settings> {
  // Block security-sensitive keys from being saved
  for (const key of CLI_ONLY_KEYS) {
    if (key in settings) {
      delete settings[key];
    }
  }

  const dir = path.join(cwd, SETTINGS_DIR);
  await fs.mkdir(dir, { recursive: true });
  const filepath = path.join(dir, SETTINGS_FILE);

  let existing: Record<string, unknown> = {};
  try {
    existing = JSON.parse(await fs.readFile(filepath, "utf-8")) as Record<string, unknown>;
  } catch { /* no existing file */ }

  const merged = { ...existing, ...settings } as Settings;
  await fs.writeFile(filepath, JSON.stringify(merged, null, 2) + "\n", "utf-8");
  return merged;
}

/**
 * Save a single setting key.
 */
export async function saveSetting(cwd: string, key: string, value: unknown): Promise<Settings> {
  return saveSettings(cwd, { [key]: value });
}