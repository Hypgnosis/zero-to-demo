/**
 * ═══════════════════════════════════════════════════════════════════
 * GET /api/debug/pipeline
 *
 * Diagnostic endpoint: Tests the entire REST pipeline in isolation.
 * Tests: API key → embedding → file list.
 * Returns a JSON report of what works and what doesn't.
 *
 * DELETE THIS FILE after debugging is complete.
 * ═══════════════════════════════════════════════════════════════════
 */

import { NextResponse } from 'next/server';
import { getApiKey, embedText } from '@/lib/embeddings';

export const dynamic = 'force-dynamic';

export async function GET() {
  const report: Record<string, unknown> = {
    timestamp: new Date().toISOString(),
  };

  // 1. API Key check
  try {
    const key = getApiKey();
    report.apiKey = {
      ok: true,
      prefix: key.substring(0, 4) + '…',
      length: key.length,
    };
  } catch (err: any) {
    report.apiKey = { ok: false, error: err.message };
    return NextResponse.json(report);
  }

  // 2. Test embedding (direct REST)
  try {
    const embedding = await embedText('Hello world diagnostic test.');
    report.embedding = {
      ok: true,
      dimensions: embedding.length,
      sample: embedding.slice(0, 3),
    };
  } catch (err: any) {
    report.embedding = { ok: false, error: err.message };
  }

  // 3. Test generateContent (direct REST) — just echo test
  try {
    const apiKey = getApiKey();
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [
            {
              role: 'user',
              parts: [{ text: 'Say "Pipeline OK" in exactly two words.' }],
            },
          ],
        }),
      }
    );

    if (!res.ok) {
      const errText = await res.text();
      report.generateContent = { ok: false, status: res.status, error: errText };
    } else {
      const data = await res.json();
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
      report.generateContent = { ok: true, response: text?.substring(0, 100) };
    }
  } catch (err: any) {
    report.generateContent = { ok: false, error: err.message };
  }

  // 4. Test file list (direct REST)
  try {
    const apiKey = getApiKey();
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/files?key=${apiKey}`
    );
    if (!res.ok) {
      const errText = await res.text();
      report.fileList = { ok: false, status: res.status, error: errText };
    } else {
      const data = await res.json();
      report.fileList = {
        ok: true,
        fileCount: data.files?.length ?? 0,
      };
    }
  } catch (err: any) {
    report.fileList = { ok: false, error: err.message };
  }

  // 5. QStash / Base URL config
  report.config = {
    NEXT_PUBLIC_BASE_URL: process.env.NEXT_PUBLIC_BASE_URL || '(not set)',
    QSTASH_TOKEN: process.env.QSTASH_TOKEN ? 'set' : 'MISSING',
    QSTASH_CURRENT_SIGNING_KEY: process.env.QSTASH_CURRENT_SIGNING_KEY ? 'set' : 'MISSING',
    QSTASH_NEXT_SIGNING_KEY: process.env.QSTASH_NEXT_SIGNING_KEY ? 'set' : 'MISSING',
    UPSTASH_REDIS_REST_URL: process.env.UPSTASH_REDIS_REST_URL ? 'set' : 'MISSING',
    UPSTASH_VECTOR_REST_URL: process.env.UPSTASH_VECTOR_REST_URL ? 'set' : 'MISSING',
  };

  return NextResponse.json(report, { status: 200 });
}
