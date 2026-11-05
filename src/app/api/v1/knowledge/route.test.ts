import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeFakeDb } from './test-helpers';

const state = vi.hoisted(() => ({
  fake: null as unknown,
  scopes: [] as string[],
  ingest: vi.fn(),
  embeddingsKey: { key: null as string | null, corrupt: false },
}));

vi.mock('@/lib/auth/api-context', () => ({
  requireApiKey: vi.fn(async (_req: Request, scope: string) => {
    state.scopes.push(scope);
    return {
      supabase: (state.fake as { db: unknown }).db,
      accountId: 'acct-1',
      createdBy: 'user-1',
    };
  }),
}));
vi.mock('@/lib/ai/config', () => ({
  loadEmbeddingsKey: vi.fn(async () => state.embeddingsKey),
}));
vi.mock('@/lib/ai/knowledge', () => ({
  ingestDocument: (...a: unknown[]) => state.ingest(...a),
}));

import { GET, POST } from './route';

const json = (body: unknown) =>
  new Request('https://x.test/api/v1/knowledge', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

let fake: ReturnType<typeof makeFakeDb>;
beforeEach(() => {
  fake = makeFakeDb();
  state.fake = fake;
  state.scopes = [];
  state.embeddingsKey = { key: null, corrupt: false };
  state.ingest.mockReset();
  state.ingest.mockResolvedValue({ keywordOnly: false, embedError: null });
});

describe('POST /api/v1/knowledge', () => {
  it('creates and indexes a document (201) under knowledge:write', async () => {
    const res = await POST(json({ title: '  Profil ICC ', content: ' Isi dokumen ' }));
    expect(res.status).toBe(201);
    const { data } = await res.json();
    expect(data).toMatchObject({
      title: 'Profil ICC',
      content: 'Isi dokumen',
      created: true,
      index_status: 'indexed',
    });
    expect(state.scopes).toEqual(['knowledge:write']);
    expect(fake.docs).toHaveLength(1);
    expect(fake.docs[0]).toMatchObject({ account_id: 'acct-1', created_by: 'user-1' });
    expect(state.ingest).toHaveBeenCalledWith(
      fake.db,
      'acct-1',
      { embeddingsApiKey: null },
      data.id,
      'Isi dokumen'
    );
  });

  it('rejects missing, blank and oversized input with 400', async () => {
    expect((await POST(json({ content: 'x' }))).status).toBe(400);
    expect((await POST(json({ title: 'x' }))).status).toBe(400);
    expect((await POST(json({ title: ' ', content: 'x' }))).status).toBe(400);
    expect((await POST(json({ title: 'a'.repeat(201), content: 'x' }))).status).toBe(400);
    expect((await POST(json({ title: 'x', content: 'a'.repeat(100_001) }))).status).toBe(400);
    expect((await POST(json({ title: 'x', content: 'y', replace_existing: 'yes' }))).status).toBe(400);
    expect((await POST(json([1]))).status).toBe(400);
    expect(fake.docs).toHaveLength(0);
    expect(state.ingest).not.toHaveBeenCalled();
  });

  it('keeps the document and reports a warning when indexing throws', async () => {
    state.ingest.mockRejectedValue(new Error('db down'));
    const res = await POST(json({ title: 'T', content: 'C' }));
    expect(res.status).toBe(201);
    const { data } = await res.json();
    expect(data.index_status).toBe('not_indexed');
    expect(data.warning).toMatch(/not searchable/);
    expect(fake.docs).toHaveLength(1);
  });

  it('reports keyword_only when embedding failed', async () => {
    state.ingest.mockResolvedValue({ keywordOnly: true, embedError: new Error('quota') });
    const { data } = await (await POST(json({ title: 'T', content: 'C' }))).json();
    expect(data.index_status).toBe('keyword_only');
    expect(data.warning).toMatch(/Keyword search still works/);
  });

  it('reports keyword_only when the stored embeddings key cannot be decrypted', async () => {
    state.embeddingsKey = { key: null, corrupt: true };
    const { data } = await (await POST(json({ title: 'T', content: 'C' }))).json();
    expect(data.index_status).toBe('keyword_only');
    expect(data.warning).toMatch(/ENCRYPTION_KEY/);
  });

  it('replace_existing updates a same-title document instead of duplicating', async () => {
    const first = await (await POST(json({ title: 'Jadwal', content: 'v1' }))).json();
    const res = await POST(json({ title: 'jadwal', content: 'v2', replace_existing: true }));
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data).toMatchObject({ id: first.data.id, content: 'v2', created: false });
    expect(fake.docs).toHaveLength(1);
    expect(fake.docs[0].content).toBe('v2');
  });

  it('replace_existing creates when no document has that title', async () => {
    const res = await POST(json({ title: 'Baru', content: 'x', replace_existing: true }));
    expect(res.status).toBe(201);
    expect(fake.docs).toHaveLength(1);
  });

  it('does not touch another account\'s document with the same title', async () => {
    fake.docs.push({
      id: '00000000-0000-4000-8000-0000000000aa',
      account_id: 'other-acct',
      created_by: null,
      title: 'Shared Title',
      content: 'theirs',
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    });
    const res = await POST(json({ title: 'Shared Title', content: 'mine', replace_existing: true }));
    expect(res.status).toBe(201);
    expect(fake.docs.find((d) => d.account_id === 'other-acct')?.content).toBe('theirs');
    expect(fake.docs).toHaveLength(2);
  });

  it('returns a 500 envelope when the insert fails', async () => {
    fake.failNext.op = 'insert';
    const res = await POST(json({ title: 'T', content: 'C' }));
    expect(res.status).toBe(500);
    expect((await res.json()).error.code).toBe('internal');
  });
});

describe('GET /api/v1/knowledge', () => {
  it('lists only this account\'s documents, without content, under knowledge:read', async () => {
    await POST(json({ title: 'A', content: 'aaa' }));
    fake.docs.push({
      id: '00000000-0000-4000-8000-0000000000bb',
      account_id: 'other-acct',
      created_by: null,
      title: 'Other',
      content: 'x',
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    });
    state.scopes = [];
    const res = await GET(new Request('https://x.test/api/v1/knowledge'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.map((d: { title: string }) => d.title)).toEqual(['A']);
    expect(body.data[0]).not.toHaveProperty('content');
    expect(body.meta).toEqual({ next_cursor: null });
    expect(state.scopes).toEqual(['knowledge:read']);
  });
});
