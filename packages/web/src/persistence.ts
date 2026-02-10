import { writeFile, rename, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import type { PersistedData } from './types.js';
import { log } from './logger.js';

export class SessionPersistence {
  private filePath: string;
  private writeTimer: NodeJS.Timeout | null = null;
  private pendingData: PersistedData | null = null;
  private readonly writeDebounceMs = 5000;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  /**
   * Load persisted data from disk on startup.
   * Returns empty data structure if file doesn't exist or is corrupt.
   */
  async load(): Promise<PersistedData> {
    if (!existsSync(this.filePath)) {
      log('persistence: no existing file found, starting fresh');
      return {
        version: 1,
        lastUpdated: new Date().toISOString(),
        sessions: [],
      };
    }

    try {
      const content = await readFile(this.filePath, 'utf8');
      const data = JSON.parse(content) as PersistedData;

      // Validate structure
      if (!data || typeof data !== 'object' || !Array.isArray(data.sessions)) {
        throw new Error('Invalid data structure');
      }

      log('persistence: loaded data', {
        version: data.version,
        sessions: data.sessions.length,
        lastUpdated: data.lastUpdated,
      });

      return data;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log('persistence: failed to load, marking as corrupt', { error: msg });

      // Rename corrupt file
      const corruptPath = `${this.filePath}.corrupt.${Date.now()}`;
      try {
        await rename(this.filePath, corruptPath);
        log('persistence: renamed corrupt file', { to: corruptPath });
      } catch {
        // Ignore rename errors
      }

      return {
        version: 1,
        lastUpdated: new Date().toISOString(),
        sessions: [],
      };
    }
  }

  /**
   * Schedule a debounced write to disk.
   * Multiple rapid calls will be batched into a single write.
   */
  scheduleWrite(data: PersistedData): void {
    this.pendingData = data;

    if (this.writeTimer) {
      // Already scheduled, will use the latest data
      return;
    }

    this.writeTimer = setTimeout(() => {
      this.writeTimer = null;
      if (this.pendingData) {
        const toWrite = this.pendingData;
        this.pendingData = null;
        void this.writeNow(toWrite).catch((err) => {
          const msg = err instanceof Error ? err.message : String(err);
          log('persistence: scheduled write failed', { error: msg });
        });
      }
    }, this.writeDebounceMs);
  }

  /**
   * Write data to disk immediately (bypassing debounce).
   * Used during server shutdown to ensure final state is persisted.
   */
  async writeNow(data: PersistedData): Promise<void> {
    const tmpPath = `${this.filePath}.tmp`;
    const backupPath = `${this.filePath}.backup`;

    try {
      // Write to temp file
      const content = JSON.stringify(data, null, 2);
      await writeFile(tmpPath, content, 'utf8');

      // Atomic rename: backup existing file
      if (existsSync(this.filePath)) {
        try {
          await rename(this.filePath, backupPath);
        } catch {
          // Ignore backup errors
        }
      }

      // Atomic rename: move temp to main
      await rename(tmpPath, this.filePath);

      log('persistence: write complete', {
        sessions: data.sessions.length,
        instances: data.sessions.reduce((sum, s) => sum + s.instances.length, 0),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log('persistence: write failed', { error: msg });
      throw err;
    }
  }

  /**
   * Cancel any pending writes and clear state.
   */
  cleanup(): void {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer);
      this.writeTimer = null;
    }
    this.pendingData = null;
  }
}
