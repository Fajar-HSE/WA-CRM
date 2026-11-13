import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  logged: [] as { source: string; err: Error; opts: Record<string, unknown> }[],
  platform: false,
  selects: [] as string[],
  rows: [] as unknown[],
  denied: false,
}));

vi.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({ body, status: init?.status ?? 200 }),
  },
}));

function makeDb() {
  const chain: Record<string, unknown> = {};
  const self = () => chain;
  chain.select = (cols: string) => {
    h.selects.push(cols);
    return chain;
  };
  chain.eq = self;
  chain.or = self;
  chain.is = self;
  chain.not = self;
  chain.order = self;
  chain.limit = async () => ({ data: h.rows, error: null });
  chain.maybeSingle = async () => ({ data: { can_create_workspaces: h.platform }, error: null });
  return { from: () => chain };
}

vi.mock('@/lib/auth/account', () => ({
  requireRole: async () => {
    if (h.denied) throw new Error('forbidden');
    return { supabase: makeDb(), accountId: 'acc-1', userId: 'user-1', role: 'admin' };
  },
  getCurrentAccount: async () => ({ userId: 'user-1', accountId: 'acc-1' }),
  toErrorResponse: (err: unknown) => ({
    body: { error: err instanceof Error ? err.message : 'error' },
    status: 403,
  }),
}));
vi.mock('@/lib/ai/admin-client', () => ({ supabaseAdmin: () => makeDb() }));
vi.mock('@/lib/logging/error-log', () => ({
  logError: async (source: string, err: Error, opts: Record<string, unknown>) => {
    h.logged.push({ source, err, opts });
  },
}));

import { GET, POST } from './route';
import { __resetRateLimitForTests } from '@/lib/rate-limit';

const post = (body: unknown) =>
  POST(
    new Request('http://t/api/error-logs', { method: 'POST', body: JSON.stringify(body) }),
  ) as unknown as Promise<{ status: number; body: Record<string, unknown> }>;

beforeEach(() => {
  __resetRateLimitForTests();
  h.logged = [];
  h.selects = [];
  h.rows = [];
  h.platform = false;
  h.denied = false;
});

describe('POST /api/error-logs (browser report)', () => {
  it('stores the report as source "ui" under the caller\'s account', async () => {
    const res = await post({
      message: 'x is not a function',
      stack: 'Error\n at f (app.js:1:1)',
      url: 'https://crm.test/inbox?token=secret#frag',
      kind: 'render',
      digest: 'abc123',
    });
    expect(res.status).toBe(200);
    expect(h.logged).toHaveLength(1);
    expect(h.logged[0].source).toBe('ui');
    expect(h.logged[0].opts.accountId).toBe('acc-1');
    expect(h.logged[0].opts.context).toMatchObject({ path: '/inbox', kind: 'render', digest: 'abc123' });
    expect(JSON.stringify(h.logged[0].opts.context)).not.toContain('secret');
  });

  it('rejects an empty or non-object body', async () => {
    expect((await post({})).status).toBe(400);
    expect((await post({ message: '   ' })).status).toBe(400);
    expect(h.logged).toHaveLength(0);
  });

  it('limits a user to 10 reports a minute', async () => {
    for (let i = 0; i < 10; i++) expect((await post({ message: `m${i}` })).status).toBe(200);
    expect((await post({ message: 'one too many' })).status).toBe(429);
  });
});

describe('GET /api/error-logs', () => {
  it('returns the rows for an admin', async () => {
    h.rows = [{ id: '1', message: 'boom' }];
    const res = (await GET(new Request('http://t/api/error-logs?status=open'))) as unknown as {
      status: number;
      body: { logs: unknown[] };
    };
    expect(res.status).toBe(200);
    expect(res.body.logs).toHaveLength(1);
  });

  it('is refused for non-admins', async () => {
    h.denied = true;
    const res = (await GET(new Request('http://t/api/error-logs'))) as unknown as { status: number };
    expect(res.status).toBe(403);
  });
});
