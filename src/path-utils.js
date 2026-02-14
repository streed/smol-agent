import path from "node:path";
import fs from "node:fs";

/**
 * Resolve a path relative to a base directory and ensure it stays within bounds.
 * @param {string} basePath - The base directory (jail boundary)
 * @param {string} targetPath - The path to resolve
 * @returns {string} The resolved absolute path
 * @throws {Error} If the resolved path would escape the base directory
 */
export function resolveJailedPath(basePath, targetPath) {
  // Resolve the target path to an absolute path
  const resolvedPath = path.resolve(basePath, targetPath);
  
  // Ensure the resolved path is within the base path
  const relative = path.relative(basePath, resolvedPath);
  
  // Check if the relative path starts with '..' or is an absolute path
  // This would indicate escaping outside the base directory
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Path '${targetPath}' escapes the jail directory`);
  }
  
  return resolvedPath;
}

/**
 * Validate that a path is within the jail directory and exists.
 * @param {string} basePath - The base directory (jail boundary)
 * @param {string} targetPath - The path to validate
 * @returns {string} The resolved absolute path
 * @throws {Error} If the path escapes the jail or doesn't exist
 */
export function validateJailedPath(basePath, targetPath) {
  const resolvedPath = resolveJailedPath(basePath, targetPath);
  
  // Check if the file/directory exists
  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`Path '${targetPath}' does not exist`);
  }
  
  return resolvedPath;
}