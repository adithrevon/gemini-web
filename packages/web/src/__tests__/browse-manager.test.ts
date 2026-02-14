import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { BrowseManager } from '../browse-manager.js';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('BrowseManager', () => {
  let testDir: string;
  let browseManager: BrowseManager;

  beforeAll(() => {
    // Create a temporary test directory structure
    testDir = join(tmpdir(), `browse-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });

    // Create subdirectories
    mkdirSync(join(testDir, 'project-dir'));
    mkdirSync(join(testDir, 'regular-dir'));
    mkdirSync(join(testDir, '.hidden-dir'));

    // Add project indicators to project-dir
    writeFileSync(join(testDir, 'project-dir', 'package.json'), '{}');
    writeFileSync(join(testDir, 'project-dir', '.git'), '');

    browseManager = new BrowseManager();
  });

  afterAll(() => {
    // Clean up test directory
    rmSync(testDir, { recursive: true, force: true });
  });

  describe('browse()', () => {
    it('lists subdirectories in a path', () => {
      const result = browseManager.browse(testDir);

      expect(result.path).toBe(testDir);
      expect(result.directories).toHaveLength(2); // Excludes .hidden-dir
      expect(result.directories.map(d => d.name)).toContain('project-dir');
      expect(result.directories.map(d => d.name)).toContain('regular-dir');
      expect(result.directories.map(d => d.name)).not.toContain('.hidden-dir');
    });

    it('detects project directories', () => {
      const result = browseManager.browse(join(testDir, 'project-dir'));

      expect(result.isProject).toBe(true);
      expect(result.name).toBe('project-dir');
    });

    it('detects non-project directories', () => {
      const result = browseManager.browse(join(testDir, 'regular-dir'));

      expect(result.isProject).toBe(false);
      expect(result.name).toBe('regular-dir');
    });

    it('returns parent directory path', () => {
      const result = browseManager.browse(join(testDir, 'regular-dir'));

      expect(result.parent).toBe(testDir);
    });

    it('sorts directories alphabetically', () => {
      const result = browseManager.browse(testDir);

      const names = result.directories.map(d => d.name);
      const sorted = [...names].sort((a, b) => a.localeCompare(b));
      expect(names).toEqual(sorted);
    });

    it('handles tilde expansion', () => {
      const result = browseManager.browse('~');

      expect(result.path).not.toContain('~');
      expect(result.path).toMatch(/^\/.*$/); // Should be absolute path
    });
  });

  describe('validatePath()', () => {
    it('validates existing directory as valid', () => {
      const result = browseManager.validatePath(testDir);

      expect(result.valid).toBe(true);
      expect(result.path).toBe(testDir);
      expect(result.error).toBeUndefined();
    });

    it('detects project indicators', () => {
      const result = browseManager.validatePath(join(testDir, 'project-dir'));

      expect(result.valid).toBe(true);
      expect(result.isProject).toBe(true);
    });

    it('detects non-project directories', () => {
      const result = browseManager.validatePath(join(testDir, 'regular-dir'));

      expect(result.valid).toBe(true);
      expect(result.isProject).toBe(false);
    });

    it('returns invalid for non-existent path', () => {
      const result = browseManager.validatePath(join(testDir, 'does-not-exist'));

      expect(result.valid).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('returns invalid for file path', () => {
      const filePath = join(testDir, 'test-file.txt');
      writeFileSync(filePath, 'test');

      const result = browseManager.validatePath(filePath);

      expect(result.valid).toBe(false);
      expect(result.error).toContain('not a directory');
    });

    it('handles tilde expansion', () => {
      const result = browseManager.validatePath('~');

      expect(result.valid).toBe(true);
      expect(result.path).not.toContain('~');
    });
  });

  describe('project detection', () => {
    it('detects package.json', () => {
      const dir = join(testDir, 'npm-project');
      mkdirSync(dir);
      writeFileSync(join(dir, 'package.json'), '{}');

      const result = browseManager.validatePath(dir);
      expect(result.isProject).toBe(true);
    });

    it('detects .git', () => {
      const dir = join(testDir, 'git-project');
      mkdirSync(dir);
      mkdirSync(join(dir, '.git'));

      const result = browseManager.validatePath(dir);
      expect(result.isProject).toBe(true);
    });

    it('detects Cargo.toml', () => {
      const dir = join(testDir, 'rust-project');
      mkdirSync(dir);
      writeFileSync(join(dir, 'Cargo.toml'), '');

      const result = browseManager.validatePath(dir);
      expect(result.isProject).toBe(true);
    });

    it('detects .xcodeproj extension', () => {
      const dir = join(testDir, 'ios-project');
      mkdirSync(dir);
      mkdirSync(join(dir, 'MyApp.xcodeproj'));

      const result = browseManager.validatePath(dir);
      expect(result.isProject).toBe(true);
    });
  });
});
