/**
 * Agent Skills system for smol-agent.
 *
 * Skills are markdown files that define reusable capabilities for the agent.
 * They are loaded from:
 * - Project-local: .smol-agent/skills/
 * - Global: ~/.config/smol-agent/skills/
 *
 * Each skill file should have a name and description in its frontmatter,
 * and can define instructions, examples, and constraints for the agent.
 *
 * Key exports:
 *   - loadSkills(cwd): Load all skills from local and global directories
 *   - validateSkillName(name): Validate skill name per spec
 *   - validateSkillDescription(name, description): Validate description
 *   - validateSkillContent(name, content): Validate skill content
 *
 * Dependencies: node:fs/promises, node:path, node:os, ./path-utils.js, ./logger.js
 * Depended on by: src/agent.js, src/context.js, src/ui/App.js,
 *                  test/unit/context.test.js, test/unit/skills.test.js
 *
 * @module skills
 */
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { resolveJailedPath } from "./path-utils.js";
import { logger } from "./logger.js";

// Directory names for skills
const SKILLS_DIR = ".smol-agent/skills";

// XDG-compliant global skills directory
const XDG_CONFIG_HOME = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
const GLOBAL_SKILLS_DIR = path.join(XDG_CONFIG_HOME, "smol-agent", "skills");

/**
 * Skill validation result
 */
export interface ValidationResult {
  valid: boolean;
  error?: string;
}

/**
 * Skill object
 */
export interface Skill {
  name: string;
  description: string;
  license?: string;
  compatibility?: string;
  metadata?: Record<string, unknown>;
  allowedTools?: string[];
  file: string;
  source: string;
  path: string;
  hasScripts: boolean;
  hasReferences: boolean;
  hasAssets: boolean;
}

/**
 * Skill resource check result
 */
interface SkillResources {
  hasScripts: boolean;
  hasReferences: boolean;
  hasAssets: boolean;
}

/**
 * Parsed frontmatter
 */
interface Frontmatter {
  data: Record<string, unknown>;
  content: string;
}

/**
 * Validate skill name according to Agent Skills specification:
 * - Required field
 * - Max 64 characters
 * - Lowercase letters, numbers, and hyphens only
 * - Cannot start or end with hyphen
 * - Cannot contain consecutive hyphens
 */
export function validateSkillName(name: string): ValidationResult {
  if (!name || typeof name !== "string") {
    return { valid: false, error: "name is required" };
  }
  if (name.length > 64) {
    return { valid: false, error: "name must be 64 characters or less" };
  }
  if (!/^[a-z0-9-]+$/.test(name)) {
    return { valid: false, error: "name must contain only lowercase letters, numbers, and hyphens" };
  }
  if (name.startsWith("-") || name.endsWith("-")) {
    return { valid: false, error: "name cannot start or end with hyphen" };
  }
  if (name.includes("--")) {
    return { valid: false, error: "name cannot contain consecutive hyphens" };
  }
  return { valid: true };
}

/**
 * Validate skill description (max 1024 chars, non-empty)
 */
export function validateSkillDescription(description: string): ValidationResult {
  if (!description || typeof description !== "string") {
    return { valid: false, error: "description is required" };
  }
  if (description.length > 1024) {
    return { valid: false, error: "description must be 1024 characters or less" };
  }
  return { valid: true };
}

/**
 * Parse YAML frontmatter from a markdown string.
 * Returns { data: { key: value, ... }, content: "body" }.
 * Handles simple key: value pairs and nested metadata.
 */
export function parseFrontmatter(text: string): Frontmatter {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { data: {}, content: text };

  const data: Record<string, unknown> = {};
  const lines = match[1].split("\n");
  let currentKey: string | null = null;

  for (const line of lines) {
    // Check for nested key-value pairs (indented 2+ spaces)
    const nestedMatch = line.match(/^(\s{2,})(\S+)\s*:\s*(.+)$/);
    if (nestedMatch && currentKey) {
      // Initialize nested object if needed
      if (!data[currentKey] || typeof data[currentKey] !== "object") {
        data[currentKey] = {};
      }
      const nestedKey = nestedMatch[2];
      const nestedValue = nestedMatch[3].replace(/^["']|["']$/g, "").trim();
      (data[currentKey] as Record<string, string>)[nestedKey] = nestedValue;
      continue;
    }

    // Reset current key if line is empty
    if (!line.trim()) {
      currentKey = null;
      continue;
    }

    // Parse top-level key: value
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const val = line.slice(idx + 1).trim();
    if (!key) continue;

    currentKey = key;

    // Handle allowed-tools as array
    if (key === "allowed-tools") {
      data[key] = val.split(/\s+/).filter(Boolean);
    } else {
      // Strip quotes from string values
      data[key] = val.replace(/^["']|["']$/g, "");
    }
  }

  return { data, content: match[2] };
}

/**
 * Check if a directory contains subdirectories for skill resources
 */
async function checkSkillResources(skillDir: string): Promise<SkillResources> {
  const result: SkillResources = { hasScripts: false, hasReferences: false, hasAssets: false };
  try {
    const entries = await fs.readdir(skillDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name === "scripts") result.hasScripts = true;
      if (entry.name === "references") result.hasReferences = true;
      if (entry.name === "assets") result.hasAssets = true;
    }
  } catch {
    // ignore
  }
  return result;
}

/**
 * Create a skill object with validation
 */
function createSkill(
  data: Record<string, unknown>,
  content: string,
  file: string,
  source: string,
  skillDir: string
): Skill | null {
  const name = (data.name as string) || path.basename(file, ".md") || path.basename(skillDir || file);
  
  // Validate name
  const nameValidation = validateSkillName(name);
  if (!nameValidation.valid) {
    logger.warn(`Skill "${file}" has invalid name: ${nameValidation.error}`);
    return null;
  }

  // Validate description
  const descValidation = validateSkillDescription((data.description as string) || "");
  if (!descValidation.valid) {
    logger.warn(`Skill "${name}" has invalid description: ${descValidation.error}`);
    return null;
  }

  return {
    name,
    description: (data.description as string) || "",
    license: data.license as string | undefined,
    compatibility: data.compatibility as string | undefined,
    metadata: data.metadata as Record<string, unknown> | undefined,
    allowedTools: data["allowed-tools"] as string[] | undefined,
    file,
    source,
    path: skillDir || path.dirname(file),
    hasScripts: false,
    hasReferences: false,
    hasAssets: false,
  };
}

/**
 * Load skills from SKILL.md files in subdirectories (standard format).
 */
async function loadStandardSkills(dirPath: string, source: string): Promise<Skill[]> {
  const skills: Skill[] = [];
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      
      const skillDir = path.join(dirPath, entry.name);
      const skillFile = path.join(skillDir, "SKILL.md");
      
      try {
        const raw = await fs.readFile(skillFile, "utf-8");
        const { data, content } = parseFrontmatter(raw);
        
        // Use directory name as default name
        if (!data.name) {
          data.name = entry.name;
        }
        
        const skill = createSkill(data, content, skillFile, source, skillDir);
        if (skill) {
          // Check for resource subdirectories
          const resources = await checkSkillResources(skillDir);
          skill.hasScripts = resources.hasScripts;
          skill.hasReferences = resources.hasReferences;
          skill.hasAssets = resources.hasAssets;
          skills.push(skill);
        }
      } catch (err) {
        // SKILL.md not found or unreadable - skip
        const error = err as Error;
        logger.debug(`Could not read ${skillFile}: ${error.message}`);
      }
    }
  } catch {
    // dir doesn't exist
  }
  return skills;
}

/**
 * Load skills from flat .md files (legacy format - for backward compatibility).
 */
async function loadLegacySkills(dirPath: string, source: string): Promise<Skill[]> {
  const skills: Skill[] = [];
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      
      const skillFile = path.join(dirPath, entry.name);
      
      try {
        const raw = await fs.readFile(skillFile, "utf-8");
        const { data, content } = parseFrontmatter(raw);
        
        const skill = createSkill(data, content, skillFile, source, dirPath);
        if (skill) {
          // Check if a standard format skill already exists with this name
          logger.debug(`Loaded legacy skill format: ${skillFile}. Consider migrating to SKILL.md format.`);
          skills.push(skill);
        }
      } catch (err) {
        const error = err as Error;
        logger.debug(`Could not read ${skillFile}: ${error.message}`);
      }
    }
  } catch {
    // dir doesn't exist
  }
  return skills;
}

/**
 * Load skills from a directory.
 * Returns [{ name, description, file, source }] or [] if dir missing.
 * Supports both:
 *   - Standard: <skill-name>/SKILL.md (Agent Skills specification)
 *   - Legacy: <name>.md (backward compatibility)
 */
async function loadSkillsFromDir(dirPath: string, source: string): Promise<Skill[]> {
  // Load legacy format first (flat .md files)
  const legacySkills = await loadLegacySkills(dirPath, source);
  
  // Then load standard format (subdirectories with SKILL.md)
  // Standard format takes precedence over legacy for same-named skills
  const standardSkills = await loadStandardSkills(dirPath, source);
  
  // Merge, preferring standard format for same-named skills
  const skillMap = new Map<string, Skill>();
  for (const skill of legacySkills) {
    skillMap.set(skill.name, skill);
  }
  for (const skill of standardSkills) {
    skillMap.set(skill.name, skill); // standard overrides legacy
  }
  
  return Array.from(skillMap.values());
}

/**
 * Load skills from both global (~/.config/smol-agent/skills) and local (.smol-agent/skills).
 * Global skills are loaded first, then local skills (local can shadow global by name).
 * Returns [{ name, description, file, source }] or [] if none found.
 */
export async function loadSkills(cwd: string): Promise<Skill[]> {
  // Load global skills first
  const globalSkills = await loadSkillsFromDir(GLOBAL_SKILLS_DIR, "global");
  
  // Then load local (project-specific) skills
  const localSkillsPath = resolveJailedPath(cwd, SKILLS_DIR);
  const localSkills = await loadSkillsFromDir(localSkillsPath, "local");
  
  // Merge: local skills shadow global skills with the same name
  const skillMap = new Map<string, Skill>();
  for (const skill of globalSkills) {
    skillMap.set(skill.name, skill);
  }
  for (const skill of localSkills) {
    skillMap.set(skill.name, skill); // local overrides global
  }
  
  return Array.from(skillMap.values());
}

/**
 * Load a resource file from a skill directory.
 * Searches both global and local skill directories.
 * Returns the file content or null if not found.
 */
export async function loadSkillResource(cwd: string, skillName: string, resourcePath: string): Promise<string | null> {
  // Build search paths (local first, then global - local shadows global)
  const localSkillDir = path.join(resolveJailedPath(cwd, SKILLS_DIR), skillName);
  const globalSkillDir = path.join(GLOBAL_SKILLS_DIR, skillName);
  
  const searchDirs = [localSkillDir, globalSkillDir];
  
  for (const dir of searchDirs) {
    try {
      // Resolve and validate the path stays within the skill directory
      const fullPath = path.join(dir, resourcePath);
      const resolved = path.resolve(fullPath);
      
      // Security check: ensure path doesn't escape the skill directory
      const normalizedDir = path.resolve(dir);
      if (!resolved.startsWith(normalizedDir + path.sep) && resolved !== normalizedDir) {
        logger.warn(`Skill resource path escape attempt: ${resourcePath}`);
        continue;
      }
      
      return await fs.readFile(resolved, "utf-8");
    } catch {
      // File not found in this directory
    }
  }
  
  return null;
}

/**
 * Get the path to a skill directory.
 * Returns null if skill not found.
 */
export async function getSkillPath(cwd: string, skillName: string): Promise<string | null> {
  const skills = await loadSkills(cwd);
  const skill = skills.find(s => s.name === skillName);
  return skill ? skill.path : null;
}

/**
 * Get list of skill names for autocomplete.
 * Returns array of { name, description } objects.
 */
export async function getSkillNames(cwd: string): Promise<Array<{ name: string; description: string }>> {
  const skills = await loadSkills(cwd);
  return skills.map(s => ({ name: s.name, description: s.description }));
}