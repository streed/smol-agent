import path from "node:path";
import fs from "node:fs";

/**
 * Resolve a path relative to a base directory and ensure it stays within bounds.
 * This function resolves symlinks to prevent escape attacks via symbolic links.
 * @param basePath - The base directory (jail boundary)
 * @param targetPath - The path to resolve
 * @returns The resolved absolute path
 * @throws Error If the resolved path would escape the base directory
 */
export function resolveJailedPath(basePath: string, targetPath: string): string {
  // First, resolve the target path relative to base
  const resolvedPath = path.resolve(basePath, targetPath);
  
  // Get the real (canonical) path of the base directory, resolving any symlinks
  let realBase: string;
  try {
    realBase = fs.realpathSync(basePath);
  } catch {
    throw new Error(`Jail directory does not exist or is not accessible: ${basePath}`);
  }
  
  // Try to get the real path of the target
  // This resolves symlinks in the path
  let realTarget: string;
  try {
    realTarget = fs.realpathSync(resolvedPath);
  } catch {
    // Path doesn't exist yet - validate the parent directory
    // and check that the eventual path would be within jail
    const parentDir = path.dirname(resolvedPath);
    try {
      const realParent = fs.realpathSync(parentDir);
      realTarget = path.join(realParent, path.basename(resolvedPath));
    } catch {
      // Parent doesn't exist either - fall back to resolved path
      // This is safe because we'll still check it doesn't escape
      realTarget = resolvedPath;
    }
  }
  
  // Check if the real target path is within the real base path
  const relative = path.relative(realBase, realTarget);
  
  // If the relative path starts with '..', it escapes the jail
  if (relative.startsWith("..")) {
    throw new Error(`Path '${targetPath}' escapes the jail directory`);
  }

  return realTarget;
}

/**
 * Validate that a path is within the jail directory and exists.
 * @param basePath - The base directory (jail boundary)
 * @param targetPath - The path to validate
 * @returns The resolved absolute path
 * @throws Error If the path escapes the jail or doesn't exist
 */
export function validateJailedPath(basePath: string, targetPath: string): string {
  const resolvedPath = resolveJailedPath(basePath, targetPath);
  
  // Also verify the real path exists and is within jail
  try {
    const realPath = fs.realpathSync(resolvedPath);
    const realBase = fs.realpathSync(basePath);
    const relative = path.relative(realBase, realPath);
    
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`Path '${targetPath}' escapes the jail directory`);
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes('escapes the jail')) {
      throw err;
    }
    // Path doesn't exist
    throw new Error(`Path '${targetPath}' does not exist`);
  }
  
  // Check if the file/directory exists (using resolved path, not real path)
  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`Path '${targetPath}' does not exist`);
  }
  
  return resolvedPath;
}