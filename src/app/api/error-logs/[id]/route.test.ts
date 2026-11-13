import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  rowAccount: 'acc-1' as string | null,
  rowExists: true,
  platform: false,
  updates: [] as Record<string, unknown>[],
  deletes: 0,
}));

vi.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({ body, status: init?.status ?? 200 }),
  },
}));

function table(name: string) {
  const chain: Record<string, unknown> = {};
  chain.select = () => chain;
  chain.eq = () => chain;
  chain.maybeSingle = async () =>
    name === 'accounts'
      ? { data: { can_create_workspaces: h.platform }, error: null }
      : { data: h.rowExists ? { account_id: h.rowAccount } : null, error: null };
  chain.update = (patch: Record<string, unknown>) => {
    h.updates.push(patch);
    return { eq: async () => ({ error: null }) };
  };
  chain.delete = () => ({
    eq: async () => {
      h.deletes += 1;
      return { error: null };
    },
  });
  return chain;
}
const db = () => ({ from: (name: string) => table(name) });

vi.mock('@/lib/auth/account', () => ({
  requireRole: async () => ({ supabase: db(), accountId: 'acc-1', userId: 'user-1' }),
  toErrorResponse: () => ({ body: { error: 'denied' }, status: 403 }),
}));
vi.mock('@/lib/ai/admin-client', () => ({ supabaseAdmin: () => db() }));

import { DELETE, PATCH } from './route';

const ID = '00000000-0000-4000-8000-000000000001';
const params = (id = ID) => ({ params: Promise.resolve({ id }) });
type Res = { status: number; body: Record<string, unknown> };
const patch = (body: unknown, id = ID) =>
  PATCH(new Request('http://t', { method: 'PATCH', body: JSON.stringify(body) }), params(id)) as unknown as Promise<Res>;

beforeEach(() => {
  h.rowAccount = 'acc-1';
  h.rowExists = true;
  h.platform = false;
  h.updates = [];
  h.deletes = 0;
});

describe('PATCH /api/error-logs/:id', () => {
  it('marks a row resolved', async () => {
    const res = await patch({ resolved: true });
    expect(res.status).toBe(200);
    expect(h.updates[0]).toMatchObject({ resolved_by: 'user-1' });
    expect(h.updates[0].resolved_at).toEqual(expect.any(String));
  });

  it('reopens a row', async () => {
    await patch({ resolved: false });
    expect(h.updates[0]).toEqual({ resolved_at: null, resolved_by: null });
  });

  it('rejects a bad id and a bad body', async () => {
    expect((await patch({ resolved: true }, 'not-a-uuid')).status).toBe(404);
    expect((await patch({ resolved: 'yes' })).status).toBe(400);
  });

  it("does not touch another account's row", async () => {
    h.rowAccount = 'acc-2';
    expect((await patch({ resolved: true })).status).toBe(404);
    expect(h.updates).toHaveLength(0);
  });

  it('lets only the platform account touch account-less rows', async () => {
    h.rowAccount = null;
    expect((await patch({ resolved: true })).status).toBe(404);
    h.platform = true;
    expect((await patch({ resolved: true })).status).toBe(200);
  });
});

describe('DELETE /api/error-logs/:id', () => {
  it('deletes an own row but not a foreign one', async () => {
    const own = (await DELETE(new Request('http://t'), params())) as unknown as Res;
    expect(own.status).toBe(200);
    expect(h.deletes).toBe(1);
    h.rowAccount = 'acc-2';
    const foreign = (await DELETE(new Request('http://t'), params())) as unknown as Res;
    expect(foreign.status).toBe(404);
    expect(h.deletes).toBe(1);
  });
});
