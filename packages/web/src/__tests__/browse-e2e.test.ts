import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, get } from './helpers.js';
import type { TestServer } from './helpers.js';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('Browse API Use Cases (E2E)', () => {
  let t: TestServer;
  let testDir: string;

  beforeAll(async () => {
    // Create test directory structure
    testDir = join(tmpdir(), `browse-e2e-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    mkdirSync(join(testDir, 'my-project'));
    mkdirSync(join(testDir, 'regular-folder'));
    mkdirSync(join(testDir, '.hidden'));
    writeFileSync(join(testDir, 'my-project', 'package.json'), '{}');

    t = await startTestServer();
  });

  afterAll(async () => {
    await t.cleanup();
    rmSync(testDir, { recursive: true, force: true });
  });

  describe('Use Case: Browse Directory Tree', () => {
    it('returns directory listing', async () => {
      const result = await get(
        t.baseUrl,
        `/api/browse?path=${encodeURIComponent(testDir)}`,
      );

      expect(result.status).toBe(200);
      expect(result.json?.['path']).toBe(testDir);
      expect(result.json?.['name']).toBeDefined();
      expect(Array.isArray(result.json?.['directories'])).toBe(true);
    });

    it('filters hidden directories', async () => {
      const result = await get(
        t.baseUrl,
        `/api/browse?path=${encodeURIComponent(testDir)}`,
      );

      expect(result.status).toBe(200);
      const dirs = result.json?.['directories'] as Array<{ name: string }>;
      const dirNames = dirs.map((d) => d.name);
      expect(dirNames).not.toContain('.hidden');
    });

    it('detects project directory', async () => {
      const projectPath = join(testDir, 'my-project');
      const result = await get(
        t.baseUrl,
        `/api/browse?path=${encodeURIComponent(projectPath)}`,
      );

      expect(result.status).toBe(200);
      expect(result.json?.['isProject']).toBe(true);
    });

    it('uses home directory by default', async () => {
      const result = await get(t.baseUrl, '/api/browse');

      expect(result.status).toBe(200);
      expect(result.json?.['path']).toBeDefined();
      expect(result.json?.['path']).not.toContain('~');
    });

    it('returns error for invalid path', async () => {
      const result = await get(
        t.baseUrl,
        '/api/browse?path=/nonexistent/path/12345',
      );

      expect(result.status).toBe(400);
      expect(result.json?.['error']).toBeDefined();
    });
  });

  describe('Use Case: Validate Selected Path', () => {
    it('validates existing directory', async () => {
      const result = await get(
        t.baseUrl,
        `/api/validate-path?path=${encodeURIComponent(testDir)}`,
      );

      expect(result.status).toBe(200);
      expect(result.json?.['valid']).toBe(true);
      expect(result.json?.['path']).toBe(testDir);
      expect(result.json?.['isProject']).toBe(false);
    });

    it('validates project directory', async () => {
      const projectPath = join(testDir, 'my-project');
      const result = await get(
        t.baseUrl,
        `/api/validate-path?path=${encodeURIComponent(projectPath)}`,
      );

      expect(result.status).toBe(200);
      expect(result.json?.['valid']).toBe(true);
      expect(result.json?.['isProject']).toBe(true);
    });

    it('returns invalid for non-existent path', async () => {
      const result = await get(
        t.baseUrl,
        '/api/validate-path?path=/does/not/exist/123',
      );

      expect(result.status).toBe(400);
      expect(result.json?.['valid']).toBe(false);
      expect(result.json?.['error']).toBeDefined();
    });

    it('returns error for missing path parameter', async () => {
      const result = await get(t.baseUrl, '/api/validate-path');

      expect(result.status).toBe(400);
      expect(result.json?.['error']).toContain('Missing path');
    });

    it('handles tilde expansion', async () => {
      const result = await get(t.baseUrl, '/api/validate-path?path=~');

      expect(result.status).toBe(200);
      expect(result.json?.['valid']).toBe(true);
      expect(result.json?.['path']).not.toContain('~');
    });
  });
});
