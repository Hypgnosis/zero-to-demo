/**
 * Integration Tests for POST /api/upload
 *
 * Validates the PDF upload endpoint: auth guard, file validation, empty content,
 * successful vectorization, and error handling.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks ────────────────────────────────────────────────────────────────────
const mockAddDocuments = vi.fn().mockResolvedValue(undefined);

vi.mock('@/lib/vectorStore', () => ({
  resetVectorStore: vi.fn(() => ({
    addDocuments: mockAddDocuments,
  })),
}));

vi.mock('pdf-parse', () => ({
  default: vi.fn().mockResolvedValue({
    text: 'This is test PDF content for the vector store. Widget A details.',
  }),
}));

vi.mock('langchain/text_splitter', () => {
  class FakeTextSplitter {
    constructor() {
      this.createDocuments = vi.fn().mockResolvedValue([
        { pageContent: 'chunk 1', metadata: { source: 'test.pdf' } },
        { pageContent: 'chunk 2', metadata: { source: 'test.pdf' } },
      ]);
    }
  }
  return { RecursiveCharacterTextSplitter: FakeTextSplitter };
});

// ─── Helpers ──────────────────────────────────────────────────────────────────
function createMockFile(name = 'test.pdf', content = 'PDF binary data') {
  const encoder = new TextEncoder();
  const encoded = encoder.encode(content);

  return {
    name,
    arrayBuffer: () => Promise.resolve(encoded.buffer),
  };
}

function buildFormDataRequest(file) {
  const formData = new Map();
  if (file !== undefined) formData.set('file', file);

  return {
    formData: () =>
      Promise.resolve({
        get: (key) => formData.get(key) ?? null,
      }),
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────
describe('POST /api/upload', () => {
  let POST;

  beforeEach(async () => {
    vi.resetModules();
    mockAddDocuments.mockClear();

    process.env.GOOGLE_API_KEY = 'real-key-here';

    const mod = await import('@/app/api/upload/route');
    POST = mod.POST;
  });

  // ── Auth guard ────────────────────────────────────────────────────────────
  it('returns 401 when GOOGLE_API_KEY is the placeholder', async () => {
    process.env.GOOGLE_API_KEY = 'your_google_api_key_here';
    const mod = await import('@/app/api/upload/route');
    const res = await mod.POST(buildFormDataRequest(createMockFile()));
    const data = await res.json();

    expect(res.status).toBe(401);
    expect(data.error).toContain('CRITICAL');
  });

  // ── File validation ───────────────────────────────────────────────────────
  it('returns 400 when no file is provided', async () => {
    const res = await POST(buildFormDataRequest(undefined));
    const data = await res.json();

    expect(res.status).toBe(400);
    expect(data.error).toContain('No PDF file');
  });

  // ── Empty PDF content ─────────────────────────────────────────────────────
  it('returns 400 when PDF text is empty', async () => {
    const pdfParse = (await import('pdf-parse')).default;
    pdfParse.mockResolvedValueOnce({ text: '   ' });

    const mod = await import('@/app/api/upload/route');
    const res = await mod.POST(buildFormDataRequest(createMockFile()));
    const data = await res.json();

    expect(res.status).toBe(400);
    expect(data.error).toContain('Could not extract');
  });

  // ── Successful path ───────────────────────────────────────────────────────
  it('returns 200 with success payload on valid upload', async () => {
    const res = await POST(buildFormDataRequest(createMockFile()));
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.success).toBe(true);
    expect(data.message).toContain('vectorized');
    expect(data.chunksProcessed).toBe(2);
  });

  it('calls resetVectorStore before adding documents', async () => {
    const { resetVectorStore } = await import('@/lib/vectorStore');

    await POST(buildFormDataRequest(createMockFile()));

    expect(resetVectorStore).toHaveBeenCalled();
    expect(mockAddDocuments).toHaveBeenCalled();
  });

  it('calls addDocuments with chunked documents', async () => {
    await POST(buildFormDataRequest(createMockFile()));

    expect(mockAddDocuments).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ pageContent: 'chunk 1' }),
        expect.objectContaining({ pageContent: 'chunk 2' }),
      ])
    );
  });

  // ── Error handling ────────────────────────────────────────────────────────
  it('returns 500 when formData parsing fails', async () => {
    const badReq = {
      formData: () => Promise.reject(new Error('bad form')),
    };

    const res = await POST(badReq);
    const data = await res.json();

    expect(res.status).toBe(500);
    expect(data.error).toContain('bad form');
  });
});
