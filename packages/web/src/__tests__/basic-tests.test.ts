import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  get,
  post,
  startMockAnthropicServer,
  startTestServer,
} from './helpers.js';
import type { MockAnthropicServer, TestServer } from './helpers.js';

let testServer: TestServer;
let mockAnthropic: MockAnthropicServer;

beforeAll(async () => {
  mockAnthropic = await startMockAnthropicServer();
  vi.stubEnv('ANTHROPIC_BASE_URL', mockAnthropic.baseUrl);
  vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-mock-dummy');
  testServer = await startTestServer();
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await testServer.cleanup();
  await mockAnthropic.cleanup();
});

beforeEach(() => {
  mockAnthropic.reset();
});

describe('Basic API Use Cases', () => {
  describe('Use Case: Health and Path Validation', () => {
    it('GET /health returns status ok', async () => {
      const response = await get(testServer.baseUrl, '/health');
      expect(response.status).toBe(200);
      expect(response.json?.['status']).toBe('ok');
    });

    it('GET /api/browse lists directories for a valid path', async () => {
      const response = await get(testServer.baseUrl, '/api/browse?path=/tmp');
      expect(response.status).toBe(200);
      expect(typeof response.json?.['path']).toBe('string');
      expect(Array.isArray(response.json?.['directories'])).toBe(true);
    });

    it('GET /api/validate-path validates existing directories', async () => {
      const response = await get(
        testServer.baseUrl,
        '/api/validate-path?path=/tmp',
      );
      expect(response.status).toBe(200);
      expect(response.json?.['valid']).toBe(true);
    });

    it('GET /api/validate-path rejects missing path query', async () => {
      const response = await get(testServer.baseUrl, '/api/validate-path');
      expect(response.status).toBe(400);
      expect(response.json?.['valid']).toBe(false);
    });
  });

  describe('Use Case: Reject Invalid Command Payloads', () => {
    let sessionId: string;

    beforeEach(async () => {
      const session = await post(testServer.baseUrl, '/api/session', {});
      sessionId = session.json?.['sessionId'] as string;
    });

    it('returns 404 for command requests on unknown sessions', async () => {
      const response = await post(
        testServer.baseUrl,
        '/api/session/nonexistent/command',
        {
          type: 'submit',
          instanceId: 'missing',
          text: 'hello',
        },
      );
      expect(response.status).toBe(404);
    });

    it('returns 400 when command type is missing', async () => {
      const response = await post(
        testServer.baseUrl,
        `/api/session/${sessionId}/command`,
        {},
      );
      expect(response.status).toBe(400);
      expect(response.json?.['error']).toBe('Invalid payload');
    });

    it('returns 400 for unsupported command type', async () => {
      const response = await post(
        testServer.baseUrl,
        `/api/session/${sessionId}/command`,
        {
          type: 'not-a-real-command',
        },
      );
      expect(response.status).toBe(400);
      expect(response.json?.['error']).toBe('Unsupported command');
    });

    it('returns 400 when spawnInstance is missing projectPath', async () => {
      const response = await post(
        testServer.baseUrl,
        `/api/session/${sessionId}/command`,
        {
          type: 'spawnInstance',
        },
      );
      expect(response.status).toBe(400);
      expect(response.json?.['error']).toBe('Missing projectPath');
    });

    it('returns 400 when submit is missing instanceId', async () => {
      const response = await post(
        testServer.baseUrl,
        `/api/session/${sessionId}/command`,
        {
          type: 'submit',
          text: 'hello',
        },
      );
      expect(response.status).toBe(400);
      expect(response.json?.['error']).toBe('Missing instanceId');
    });

    it('returns 400 when terminateInstance is missing instanceId', async () => {
      const response = await post(
        testServer.baseUrl,
        `/api/session/${sessionId}/command`,
        {
          type: 'terminateInstance',
        },
      );
      expect(response.status).toBe(400);
      expect(response.json?.['error']).toBe('Missing instanceId');
    });
  });
});
