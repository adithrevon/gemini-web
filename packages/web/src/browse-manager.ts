import { readdirSync, statSync } from 'node:fs';
import { join, dirname, basename, resolve } from 'node:path';
import { homedir } from 'node:os';
import type { DirectoryListing, PathValidation, DirectoryEntry } from './types.js';
import { createLogger } from './logger.js';

const log = createLogger('browse-manager');

const PROJECT_INDICATORS = [
  'package.json',
  '.git',
  'Cargo.toml',
  'go.mod',
  'pyproject.toml',
  'Gemfile',
  '.xcodeproj',
  '.xcworkspace',
];

/**
 * BrowseManager handles directory browsing and path validation.
 *
 * Responsibilities:
 * - List directories for project selection
 * - Validate paths before spawning instances
 * - Detect project root indicators
 */
export class BrowseManager {
  /**
   * Browse a directory and return its subdirectories.
   */
  browse(pathParam?: string): DirectoryListing {
    const dirPath = pathParam || homedir();
    const resolvedPath = this._resolvePath(dirPath);

    log.debug('Browsing directory', { dirPath, resolvedPath });

    const entries = readdirSync(resolvedPath, { withFileTypes: true });

    const directories: DirectoryEntry[] = entries
      .filter((entry) => {
        if (entry.name.startsWith('.')) return false;
        try {
          return entry.isDirectory();
        } catch {
          return false;
        }
      })
      .map((entry) => ({
        name: entry.name,
        path: join(resolvedPath, entry.name),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    const isProject = this._isProjectDirectory(entries.map(e => e.name));

    return {
      path: resolvedPath,
      parent: dirname(resolvedPath),
      directories,
      isProject,
      name: basename(resolvedPath),
    };
  }

  /**
   * Validate a path and check if it's a valid project directory.
   */
  validatePath(pathParam: string): PathValidation {
    const resolvedPath = this._resolvePath(pathParam);

    log.debug('Validating path', { pathParam, resolvedPath });

    try {
      const stat = statSync(resolvedPath);
      if (!stat.isDirectory()) {
        return {
          valid: false,
          path: resolvedPath,
          name: basename(resolvedPath),
          isProject: false,
          error: 'Path is not a directory',
        };
      }

      const entries = readdirSync(resolvedPath);
      const isProject = this._isProjectDirectory(entries);

      return {
        valid: true,
        path: resolvedPath,
        name: basename(resolvedPath),
        isProject,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Directory does not exist';
      return {
        valid: false,
        path: resolvedPath,
        name: basename(resolvedPath),
        isProject: false,
        error: msg,
      };
    }
  }

  /**
   * Resolve a path, handling tilde expansion.
   */
  private _resolvePath(pathStr: string): string {
    if (pathStr.startsWith('~')) {
      return join(homedir(), pathStr.slice(1));
    }
    return resolve(pathStr);
  }

  /**
   * Check if a directory contains project indicators.
   */
  private _isProjectDirectory(entries: string[]): boolean {
    return entries.some(
      (e) =>
        PROJECT_INDICATORS.includes(e) ||
        e.endsWith('.xcodeproj') ||
        e.endsWith('.xcworkspace'),
    );
  }
}
