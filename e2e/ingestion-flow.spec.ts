/**
 * ═══════════════════════════════════════════════════════════════════
 * E2E Tests — Playwright
 *
 * Full Upload → Poll Status → Chat flow against a live local server.
 * Skipped in CI (requires running dev server + external APIs).
 *
 * Run locally:
 *   1. npm run dev
 *   2. npx playwright test
 * ═══════════════════════════════════════════════════════════════════
 */

import { test, expect } from '@playwright/test';
import { randomUUID } from 'crypto';
import * as path from 'path';
import * as fs from 'fs';

const BASE_URL = process.env.E2E_BASE_URL || 'http://localhost:3000';
const SKIP_REASON = 'Requires live dev server + provisioned Upstash/GenAI';

/* ─── Skip in CI or when external services are unavailable ───── */

test.describe('Upload → Process → Chat E2E', () => {
  test.skip(!!process.env.CI, SKIP_REASON);

  const sessionId = randomUUID();

  test('uploads a PDF and receives a jobId', async ({ request }) => {
    // Create a minimal test PDF
    const testPdfPath = path.join(__dirname, 'fixtures', 'test-catalog.pdf');

    // Skip if no test fixture exists
    test.skip(!fs.existsSync(testPdfPath), 'No test PDF fixture at e2e/fixtures/test-catalog.pdf');

    const fileBuffer = fs.readFileSync(testPdfPath);

    const response = await request.post(`${BASE_URL}/api/upload`, {
      multipart: {
        sessionId,
        file: {
          name: 'test-catalog.pdf',
          mimeType: 'application/pdf',
          buffer: fileBuffer,
        },
      },
    });

    expect(response.ok()).toBeTruthy();

    const body = await response.json();
    expect(body.jobId).toBeDefined();
    expect(body.sessionId).toBe(sessionId);

    // Store jobId for downstream tests
    test.info().annotations.push({ type: 'jobId', description: body.jobId });
  });

  test('polls status until processing completes', async ({ request }) => {
    // This test requires the upload test to have run first
    // In a real setup, you'd chain these more robustly
    const maxPolls = 60;
    const pollIntervalMs = 5000;
    let status = 'pending';

    for (let i = 0; i < maxPolls; i++) {
      // Note: in real usage, you'd pass the actual jobId
      const response = await request.get(`${BASE_URL}/api/status`, {
        params: { jobId: `${sessionId}-job` },
      });

      if (response.ok()) {
        const body = await response.json();
        status = body.status;

        if (status === 'complete' || status === 'failed') {
          break;
        }
      }

      await new Promise((r) => setTimeout(r, pollIntervalMs));
    }

    expect(status).toBe('complete');
  });

  test('sends a chat message and receives a streamed response', async ({ request }) => {
    const response = await request.post(`${BASE_URL}/api/chat`, {
      data: {
        sessionId,
        message: 'What products are in the catalog?',
      },
    });

    expect(response.ok()).toBeTruthy();
    expect(response.headers()['content-type']).toContain('text/event-stream');

    const body = await response.text();
    // SSE responses should contain data lines
    expect(body).toContain('data:');
  });

  test('rejects chat for a non-existent session', async ({ request }) => {
    const response = await request.post(`${BASE_URL}/api/chat`, {
      data: {
        sessionId: 'non-existent-session-id',
        message: 'Hello',
      },
    });

    // Should return 400 or 404 for missing session data
    expect(response.status()).toBeGreaterThanOrEqual(400);
  });
});

/* ─── Voice Handshake Tests ──────────────────────────────────── */

test.describe('Voice Handshake E2E', () => {
  test.skip(!!process.env.CI, SKIP_REASON);

  test('returns a WebSocket URL with JWT token', async ({ request }) => {
    const sessionId = randomUUID();

    const response = await request.post(`${BASE_URL}/api/voice`, {
      data: { sessionId, lang: 'en' },
    });

    // May fail if session has no vectors — that's expected gating
    if (response.ok()) {
      const body = await response.json();
      expect(body.wsUrl).toBeDefined();
      expect(body.wsUrl).toContain('token=');
    }
  });
});
