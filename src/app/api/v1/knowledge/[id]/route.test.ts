import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeFakeDb, type FakeDoc } from '../test-helpers';

const state = vi.hoisted(() => ({
  fake: null as unknown,
  scopes: [] as string[],
  ingest: vi.fn(),
}));

vi.mock('@/lib/auth/api-context', () => ({
  requireApiKey: vi.fn(async (_req: Request, scope: string) => {
    state.scopes.push(scope);
    return { supabase: (state.fake as { db: unknown }).db, accountId: 'acct-1', createdBy: null };
  }),
}));
vi.mock('@/lib/ai/config', () => ({
  loadEmbeddingsSettings: vi.fn(async () => ({ settings: null, corrupt: false })),
}));
vi.mock('@/lib/ai/knowledge', () => ({
  ingestDocument: (...a: unknown[]) => state.ingest(...a),
}));

import { GET, PATCH, DELETE } from './route';

const ID = '00000000-0000-4000-8000-000000000001';
const OTHER = '00000000-0000-4000-8000-000000000002';
const doc = (over: Partial<FakeDoc>): FakeDoc => ({
  id: ID,
  account_id: 'acct-1',
  created_by: null,
  title: 'Judul',
  content: 'Isi lama',
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  ...over,
});
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const patch = (id: string, body: unknown) =>
  PATCH(
    new Request('https://x.test/api/v1/knowledge/x', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    params(id)
  );
const req = (method: string) => new Request('https://x.test/api/v1/knowledge/x', { method });

let fake: ReturnType<typeof makeFakeDb>;
beforeEach(() => {
  fake = makeFakeDb([doc({}), doc({ id: OTHER, account_id: 'other-acct', title: 'Rahasia' })]);
  state.fake = fake;
  state.scopes = [];
  state.ingest.mockReset();
  state.ingest.mockResolvedValue({ keywordOnly: false, embedError: null });
});

describe('GET /api/v1/knowledge/{id}', () => {
  it('returns the full document under knowledge:read', async () => {
    const res = await GET(req('GET'), params(ID));
    expect(res.status).toBe(200);
    expect((await res.json()).data).toMatchObject({ id: ID, content: 'Isi lama' });
    expect(state.scopes).toEqual(['knowledge:read']);
  });

  it('404s for another account\'s document, a missing one and a malformed id', async () => {
    expect((await GET(req('GET'), params(OTHER))).status).toBe(404);
    expect((await GET(req('GET'), params('00000000-0000-4000-8000-0000000000ff'))).status).toBe(404);
    expect((await GET(req('GET'), params('not-a-uuid'))).status).toBe(404);
  });
});

describe('PATCH /api/v1/knowledge/{id}', () => {
  it('updates content and re-indexes it', async () => {
    const res = await patch(ID, { content: 'Isi baru' });
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data).toMatchObject({ content: 'Isi baru', index_status: 'indexed' });
    expect(state.ingest).toHaveBeenCalledTimes(1);
    expect(state.scopes).toEqual(['knowledge:write']);
  });

  it('a title-only change does not re-index', async () => {
    const res = await patch(ID, { title: 'Judul Baru' });
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data.title).toBe('Judul Baru');
    expect(data).not.toHaveProperty('index_status');
    expect(state.ingest).not.toHaveBeenCalled();
  });

  it('400s on an empty body, blank fields, or non-object body', async () => {
    expect((await patch(ID, {})).status).toBe(400);
    expect((await patch(ID, { content: '  ' })).status).toBe(400);
    expect((await patch(ID, { title: 5 })).status).toBe(400);
    expect((await patch(ID, null)).status).toBe(400);
  });

  it('cannot update another account\'s document (404, untouched)', async () => {
    expect((await patch(OTHER, { content: 'hack' })).status).toBe(404);
    expect(fake.docs.find((d) => d.id === OTHER)?.content).toBe('Isi lama');
    expect(state.ingest).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/v1/knowledge/{id}', () => {
  it('deletes the document under knowledge:write', async () => {
    const res = await DELETE(req('DELETE'), params(ID));
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual({ id: ID, deleted: true });
    expect(fake.docs.find((d) => d.id === ID)).toBeUndefined();
    expect(state.scopes).toEqual(['knowledge:write']);
  });

  it('404s for another account\'s or an unknown document and deletes nothing', async () => {
    expect((await DELETE(req('DELETE'), params(OTHER))).status).toBe(404);
    expect((await DELETE(req('DELETE'), params('nope'))).status).toBe(404);
    expect(fake.docs).toHaveLength(2);
  });
});
