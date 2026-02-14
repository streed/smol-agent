import fs from 'fs';
import path from 'path';
import { glob } from 'glob';

// Default extensions to scan (all common code file types)
const DEFAULT_EXTENSIONS = [
  '.js', '.jsx', '.ts', '.tsx', '.json',
  '.py', '.rb', '.go', '.rs', '.java', '.c', '.cpp', '.h', '.hpp',
  '.php', '.swift', '.kt', '.scala', '.groovy', '.sh', '.bash',
  '.sql', '.html', '.css', '.scss', '.sass', '.less',
  '.vue', '.svelte', '.elm', '.erl', '.ex', '.hs', '.rlib', '.cmake',
  '.r', '.m', '.mm', '.mjs', '.cjs', '.tsm', '.cts', '.mts'
];

// Regex patterns for detecting functions and classes
const PATTERN_FUNCTION = /(?:export\s+)?(?:async\s+)?function\s+(\w+)/g;
const PATTERN_ARROW_FUNCTION = /(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>|const\s+(\w+)\s*=\s*(?:async\s*)?function\s*\(/g;
const PATTERN_CLASS = /(?:export\s+)?class\s+(\w+)/g;
const PATTERN_INTERFACE = /(?:export\s+)?interface\s+(\w+)/g;
const PATTERN_ENUM = /(?:export\s+)?enum\s+(\w+)/g;

/**
 * Generate a repo map for a project
 * @param {string} cwd - Current working directory
 * @param {string[]} extensions - File extensions to scan
 * @returns {Promise<Object>} - Map of file paths to function/class names
 */
export async function generateRepoMap(cwd, extensions = DEFAULT_EXTENSIONS) {
  const repoMap = {};
  
  // Build glob pattern
  const pattern = `**/*{${extensions.join(',')}}`;
  
  try {
    const files = await glob(pattern, {
      cwd,
      ignore: ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/build/**'],
    });
    
    for (const file of files) {
      const fullPath = path.join(cwd, file);
      try {
        const content = fs.readFileSync(fullPath, 'utf-8');
        const symbols = extractSymbols(content, file);
        if (symbols.length > 0) {
          repoMap[file] = symbols;
        }
      } catch (err) {
        // Skip files that can't be read
        console.warn(`Could not read ${file}: ${err.message}`);
      }
    }
  } catch (err) {
    console.warn(`Error scanning project: ${err.message}`);
  }
  
  // Save to state directory
  saveRepoMap(repoMap, cwd);
  
  return repoMap;
}

/**
 * Extract function and class names from file content
 * @param {string} content - File content
 * @param {string} filePath - File path for context
 * @returns {string[]} - Array of symbol names
 */
function extractSymbols(content, filePath) {
  const symbols = new Set();
  
  // Extract functions
  let match;
  while ((match = PATTERN_FUNCTION.exec(content)) !== null) {
    symbols.add(`function ${match[1]}`);
  }
  
  // Extract arrow functions
  while ((match = PATTERN_ARROW_FUNCTION.exec(content)) !== null) {
    if (match[1]) {
      symbols.add(`function ${match[1]}`);
    } else if (match[2]) {
      symbols.add(`function ${match[2]}`);
    }
  }
  
  // Extract classes
  while ((match = PATTERN_CLASS.exec(content)) !== null) {
    symbols.add(`class ${match[1]}`);
  }
  
  // Extract interfaces (TypeScript)
  while ((match = PATTERN_INTERFACE.exec(content)) !== null) {
    symbols.add(`interface ${match[1]}`);
  }
  
  // Extract enums
  while ((match = PATTERN_ENUM.exec(content)) !== null) {
    symbols.add(`enum ${match[1]}`);
  }
  
  return Array.from(symbols);
}

/**
 * Save repo map to state directory
 * @param {Object} repoMap - Repo map object
 * @param {string} cwd - Current working directory
 */
function saveRepoMap(repoMap, cwd) {
  const stateDir = path.join(cwd, '.smol-agent', 'state');
  
  if (!fs.existsSync(stateDir)) {
    fs.mkdirSync(stateDir, { recursive: true });
  }
  
  const mapPath = path.join(stateDir, 'repo-map.json');
  fs.writeFileSync(mapPath, JSON.stringify(repoMap, null, 2), 'utf-8');
}

/**
 * Load cached repo map from state directory
 * @param {string} cwd - Current working directory
 * @returns {Object|null} - Cached repo map or null if not found
 */
export function loadCachedRepoMap(cwd) {
  const mapPath = path.join(cwd, '.smol-agent', 'state', 'repo-map.json');
  
  try {
    if (fs.existsSync(mapPath)) {
      const content = fs.readFileSync(mapPath, 'utf-8');
      return JSON.parse(content);
    }
  } catch (err) {
    console.warn(`Error loading repo map: ${err.message}`);
  }
  
  return null;
}

/**
 * Get a human-readable summary of the repo map
 * @param {Object} repoMap - Repo map object
 * @param {string} cwd - Current working directory
 * @returns {string} - Formatted repo map string
 */
export function getRepoMapSummary(repoMap, cwd) {
  if (Object.keys(repoMap).length === 0) {
    return 'No functions or classes found.';
  }
  
  const lines = [];
  lines.push('## Repo Map');
  lines.push('');
  
  // Sort files alphabetically
  const sortedFiles = Object.keys(repoMap).sort();
  
  for (const file of sortedFiles) {
    const symbols = repoMap[file];
    lines.push(`${file}:`);
    
    for (const symbol of symbols) {
      lines.push(`  - ${symbol}`);
    }
    
    lines.push('');
  }
  
  return lines.join('\n');
}

/**
 * Update repo map for changed files
 * @param {string} cwd - Current working directory
 * @param {string[]} changedFiles - Array of changed file paths
 * @returns {Object} - Updated repo map
 */
export async function updateRepoMap(cwd, changedFiles) {
  const existingMap = loadCachedRepoMap(cwd) || {};
  
  for (const file of changedFiles) {
    try {
      const fullPath = path.join(cwd, file);
      if (fs.existsSync(fullPath)) {
        const content = fs.readFileSync(fullPath, 'utf-8');
        const symbols = extractSymbols(content, file);
        if (symbols.length > 0) {
          existingMap[file] = symbols;
        } else {
          delete existingMap[file];
        }
      } else {
        delete existingMap[file];
      }
    } catch (err) {
      console.warn(`Error updating repo map for ${file}: ${err.message}`);
    }
  }
  
  saveRepoMap(existingMap, cwd);
  return existingMap;
}
