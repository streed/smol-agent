import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

/**
 * Context tracker - tracks file changes for smart context updates
 */
class ContextTracker {
  constructor(cwd) {
    this.cwd = cwd;
    this.statePath = path.join(cwd, '.smol-agent', 'state', 'file-tracker.json');
    this.trackedFiles = this.loadState();
  }

  /**
   * Load state from file
   */
  loadState() {
    try {
      if (fs.existsSync(this.statePath)) {
        const content = fs.readFileSync(this.statePath, 'utf-8');
        return JSON.parse(content);
      }
    } catch (err) {
      console.warn(`Error loading state: ${err.message}`);
    }
    return {};
  }

  /**
   * Save state to file
   */
  saveState() {
    try {
      const stateDir = path.dirname(this.statePath);
      if (!fs.existsSync(stateDir)) {
        fs.mkdirSync(stateDir, { recursive: true });
      }
      fs.writeFileSync(this.statePath, JSON.stringify(this.trackedFiles, null, 2), 'utf-8');
    } catch (err) {
      console.warn(`Error saving state: ${err.message}`);
    }
  }

  /**
   * Calculate checksum of file content
   */
  calculateChecksum(filePath) {
    try {
      const content = fs.readFileSync(filePath);
      return crypto.createHash('sha256').update(content).digest('hex');
    } catch (err) {
      return null;
    }
  }

  /**
   * Record a file as touched
   */
  recordFileTouched(filePath) {
    const fullPath = path.resolve(this.cwd, filePath);
    try {
      const stats = fs.statSync(fullPath);
      this.trackedFiles[filePath] = {
        mtime: stats.mtimeMs,
        checksum: this.calculateChecksum(fullPath),
        lastTouched: Date.now(),
      };
      this.saveState();
    } catch (err) {
      console.warn(`Error tracking file ${filePath}: ${err.message}`);
    }
  }

  /**
   * Get all touched files
   */
  getTouchedFiles() {
    return Object.keys(this.trackedFiles);
  }

  /**
   * Check if a file has changed since it was touched
   */
  hasFileChanged(filePath) {
    const tracked = this.trackedFiles[filePath];
    if (!tracked) return true; // Not tracked, so effectively changed
    
    const fullPath = path.resolve(this.cwd, filePath);
    try {
      const stats = fs.statSync(fullPath);
      
      // Check mtime first (faster)
      if (stats.mtimeMs !== tracked.mtime) {
        // mtime changed, verify with checksum
        const currentChecksum = this.calculateChecksum(fullPath);
        return currentChecksum !== tracked.checksum;
      }
      
      return false;
    } catch (err) {
      // File doesn't exist
      return true;
    }
  }

  /**
   * Get all files that have changed
   */
  getChangedFiles() {
    const changed = [];
    for (const filePath of Object.keys(this.trackedFiles)) {
      if (this.hasFileChanged(filePath)) {
        changed.push(filePath);
      }
    }
    return changed;
  }

  /**
   * Reset file tracking (for /reset command)
   */
  resetFileTracking() {
    this.trackedFiles = {};
    this.saveState();
  }

  /**
   * Update tracker when context is gathered
   */
  updateAfterContextGather(filesToTrack) {
    const now = Date.now();
    
    for (const file of filesToTrack) {
      const fullPath = path.resolve(this.cwd, file);
      try {
        if (fs.existsSync(fullPath)) {
          const stats = fs.statSync(fullPath);
          this.trackedFiles[file] = {
            mtime: stats.mtimeMs,
            checksum: this.calculateChecksum(fullPath),
            lastTouched: now,
          };
        }
      } catch (err) {
        console.warn(`Error updating tracker for ${file}: ${err.message}`);
      }
    }
    
    this.saveState();
  }

  /**
   * Get stats for a specific file
   */
  getFileStats(filePath) {
    return this.trackedFiles[filePath] || null;
  }
}

export default ContextTracker;
