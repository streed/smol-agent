/**
 * File Documentation Utility
 *
 * Tracks files edited during an agent session and provides utilities for
 * generating and updating file-level documentation headers. Files longer
 * than 100 lines should have a documentation block at the top summarizing:
 *   - What the file does
 *   - Its dependencies (imports/requires)
 *   - What depends on it (reverse dependency analysis)
 *
 * Key exports:
 *   - trackEditedFile(path): Add a file to the edited-files set
 *   - getEditedFiles(): Return all tracked edited files
 *   - analyzeFilesForDocumentation(agent): Main entry for reflection tool
 *   - findDependents(file, cwd): Find files that depend on target file
 *
 * Dependencies: node:fs, node:path
 * Depended on by: src/agent.js, src/tools/file_tools.js, src/tools/reflection.js, src/ui/App.js
 */
import fs from "node:fs";
import path from "node:path";

// ── Edited file tracker ─────────────────────────────────────────────

/** Absolute paths of files edited in this session */
const editedFiles = new Set<string>();

/**
 * Record that a file was edited during this session.
 * Called by write_file and replace_in_file after successful operations.
 * @param absolutePath - Absolute path to the edited file
 */
export function trackEditedFile(absolutePath: string): void {
  editedFiles.add(absolutePath);
}

/**
 * Get all files edited during this session.
 * @returns Array of absolute paths
 */
export function getEditedFiles(): string[] {
  return [...editedFiles];
}

/**
 * Clear the edited file tracker (e.g., after a reflection pass).
 */
export function clearEditedFiles(): void {
  editedFiles.clear();
}

// ── Comment style detection ─────────────────────────────────────────

interface CommentStyle {
  block: [string, string, string] | null;
  line: string;
}

const COMMENT_STYLES: Record<string, CommentStyle> = {
  js:     { block: ["/**", " *", " */"], line: "//" },
  ts:     { block: ["/**", " *", " */"], line: "//" },
  jsx:    { block: ["/**", " *", " */"], line: "//" },
  tsx:    { block: ["/**", " *", " */"], line: "//" },
  mjs:    { block: ["/**", " *", " */"], line: "//" },
  cjs:    { block: ["/**", " *", " */"], line: "//" },
  py:     { block: ['"""', "", '"""'], line: "#" },
  rb:     { block: ["=begin", "", "=end"], line: "#" },
  java:   { block: ["/**", " *", " */"], line: "//" },
  go:     { block: ["/*", "", "*/"], line: "//" },
  rs:     { block: ["/*!", "", "*/"], line: "//" },
  c:      { block: ["/**", " *", " */"], line: "//" },
  cpp:    { block: ["/**", " *", " */"], line: "//" },
  h:      { block: ["/**", " *", " */"], line: "//" },
  sh:     { block: null, line: "#" },
  bash:   { block: null, line: "#" },
  zsh:    { block: null, line: "#" },
};

/**
 * Get the comment style for a file based on its extension.
 * @param filePath - Path to the file
 * @returns Comment style info or null if unknown
 */
function getCommentStyle(filePath: string): CommentStyle | null {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  return COMMENT_STYLES[ext] || null;
}

// ── Dependency extraction ───────────────────────────────────────────

/**
 * Extract import/require paths from a JavaScript/TypeScript file.
 * @param content - File content
 * @returns Array of import paths
 */
function extractJSDependencies(content: string): string[] {
  const deps: string[] = [];
  // ES module imports: import ... from "path"
  const esImports = content.matchAll(/import\s+.*?\s+from\s+["']([^"']+)["']/g);
  for (const m of esImports) deps.push(m[1]);
  // Dynamic imports: import("path")
  const dynamicImports = content.matchAll(/import\(\s*["']([^"']+)["']\s*\)/g);
  for (const m of dynamicImports) deps.push(m[1]);
  // CommonJS requires: require("path")
  const requires = content.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g);
  for (const m of requires) deps.push(m[1]);
  return [...new Set(deps)];
}

/**
 * Extract import paths from a Python file.
 * @param content - File content
 * @returns Array of import paths
 */
function extractPyDependencies(content: string): string[] {
  const deps: string[] = [];
  const imports = content.matchAll(/^(?:from\s+(\S+)\s+import|import\s+(\S+))/gm);
  for (const m of imports) deps.push(m[1] || m[2]);
  return [...new Set(deps)];
}

/**
 * Extract dependencies from a file based on its type.
 * @param filePath - Path to the file
 * @param content - File content
 * @returns Array of dependency paths
 */
export function extractDependencies(filePath: string, content: string): string[] {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  if (["js", "ts", "jsx", "tsx", "mjs", "cjs"].includes(ext)) {
    return extractJSDependencies(content);
  }
  if (ext === "py") {
    return extractPyDependencies(content);
  }
  return [];
}

// ── Reverse dependency analysis ─────────────────────────────────────

/**
 * Find files in the project that import/depend on a given file.
 * Scans common source extensions for references to the target.
 * @param targetFile - Relative path of the file to find dependents of
 * @param cwd - Project root directory
 * @returns Array of relative file paths that depend on targetFile
 */
export function findDependents(targetFile: string, cwd: string): string[] {
  const dependents: string[] = [];
  const targetBasename = path.basename(targetFile, path.extname(targetFile));

  // Build search patterns from the target file name
  const searchPatterns = [
    targetBasename,
    targetFile,
    // Handle ./relative and ../relative patterns
    `./${targetFile}`,
  ];

  const sourceExts = new Set(["js", "ts", "jsx", "tsx", "mjs", "cjs", "py"]);

  function scanDir(dir: string, relBase: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      // Skip node_modules, .git, and hidden directories
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;

      const fullPath = path.join(dir, entry.name);
      const relPath = path.join(relBase, entry.name);

      if (entry.isDirectory()) {
        scanDir(fullPath, relPath);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).slice(1).toLowerCase();
        if (!sourceExts.has(ext)) continue;
        // Don't count the target file itself
        if (relPath === targetFile) continue;

        try {
          const content = fs.readFileSync(fullPath, "utf-8");
          for (const pattern of searchPatterns) {
            if (content.includes(pattern)) {
              dependents.push(relPath);
              break;
            }
          }
        } catch {
          // Skip unreadable files
        }
      }
    }
  }

  scanDir(cwd, "");
  return dependents;
}

// ── Documentation detection ─────────────────────────────────────────

/** Marker used to identify auto-generated file documentation blocks. */
const DOC_MARKER = "@file-doc";

/**
 * Check if a file already has an auto-generated documentation header.
 * @param content - File content
 * @returns Whether doc exists and where it ends
 */
export function detectExistingDocHeader(content: string): { exists: boolean; endLine: number } {
  if (!content.includes(DOC_MARKER)) {
    return { exists: false, endLine: 0 };
  }

  const lines = content.split("\n");
  // Find the end of the doc block
  let inBlock = false;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(DOC_MARKER)) inBlock = true;
    if (inBlock) {
      // Check for block comment end patterns
      if (lines[i].includes("*/") || lines[i].includes('"""') ||
          lines[i].includes("=end")) {
        return { exists: true, endLine: i + 1 };
      }
      // For line-comment-only languages (shell), find first non-comment line
      if (inBlock && !lines[i].startsWith("#") && lines[i].trim() !== "") {
        return { exists: true, endLine: i };
      }
    }
  }
  return { exists: true, endLine: lines.length };
}

// ── Main analysis function ──────────────────────────────────────────

export interface FileDocInfo {
  filePath: string;
  lineCount: number;
  dependencies: string[];
  dependents: string[];
  hasExistingDoc: boolean;
}

export interface AnalysisResult {
  filesToDocument: FileDocInfo[];
}

/**
 * Analyze files that were edited during the session and determine which
 * ones need documentation headers added or updated.
 *
 * Returns a structured report for the LLM to act on during /reflect.
 *
 * @param cwd - Project root directory
 * @param filePaths - Specific files to analyze (defaults to edited files)
 * @returns Structured analysis result
 */
export function analyzeFilesForDocumentation(cwd: string, filePaths?: string[]): AnalysisResult {
  const files = filePaths || getEditedFiles();
  const filesToDocument: FileDocInfo[] = [];

  for (const absPath of files) {
    // Only process files that exist and are source code
    if (!fs.existsSync(absPath)) continue;

    if (!getCommentStyle(absPath)) continue; // Skip unknown file types

    let content: string;
    try {
      content = fs.readFileSync(absPath, "utf-8");
    } catch {
      continue;
    }

    const lineCount = content.split("\n").length;
    if (lineCount <= 100) continue; // Only document files >100 lines

    const relPath = path.relative(cwd, absPath);
    const dependencies = extractDependencies(absPath, content);
    const dependents = findDependents(relPath, cwd);
    const { exists: hasExistingDoc } = detectExistingDocHeader(content);

    filesToDocument.push({
      filePath: relPath,
      lineCount,
      dependencies,
      dependents,
      hasExistingDoc,
    });
  }

  return { filesToDocument };
}

// ── Full project scan ───────────────────────────────────────────────

/**
 * Find all source code files in the project directory.
 * Returns absolute paths of files with recognized source extensions.
 * Skips node_modules, .git, and hidden directories.
 *
 * @param cwd - Project root directory
 * @returns Array of absolute file paths
 */
export function findAllSourceFiles(cwd: string): string[] {
  const sourceExts = new Set(Object.keys(COMMENT_STYLES));
  const results: string[] = [];

  function scanDir(dir: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;

      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        scanDir(fullPath);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).slice(1).toLowerCase();
        if (sourceExts.has(ext)) {
          results.push(fullPath);
        }
      }
    }
  }

  scanDir(cwd);
  return results;
}

/**
 * Analyze ALL source files in the project (not just edited ones) for
 * documentation needs. Used by the /document command for full-project
 * documentation passes.
 *
 * @param cwd - Project root directory
 * @returns Structured analysis result
 */
export function analyzeAllFilesForDocumentation(cwd: string): AnalysisResult {
  const allFiles = findAllSourceFiles(cwd);
  return analyzeFilesForDocumentation(cwd, allFiles);
}