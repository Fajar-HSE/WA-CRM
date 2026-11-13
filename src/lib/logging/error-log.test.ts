import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  rpc: vi.fn(),
}));
vi.mock('@/lib/ai/admin-client', () => ({
  supabaseAdmin: () => ({ rpc: h.rpc }),
}));

import {
  __resetErrorLogThrottleForTests,
  allowWrite,
  fingerprintFor,
  logError,
} from './error-log';

beforeEach(() => {
  __resetErrorLogThrottleForTests();
  h.rpc.mockReset();
  h.rpc.mockResolvedValue({ error: null });
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'http://db.test');
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service');
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('logError', () => {
  it('writes a cleaned report through record_error_log', async () => {
    await logError('waha.webhook', new Error('failed for 6281234567890 token=abcdef123456'), {
      accountId: 'acc-1',
      context: { stage: 'inbound', apiKey: 'sk-live-xxxxxxxxxxxx', text: 'pesan' },
    });
    expect(h.rpc).toHaveBeenCalledTimes(1);
    const [fn, args] = h.rpc.mock.calls[0];
    expect(fn).toBe('record_error_log');
    expect(args.p_account_id).toBe('acc-1');
    expect(args.p_source).toBe('waha.webhook');
    expect(args.p_level).toBe('error');
    expect(args.p_message).not.toContain('6281234567890');
    expect(args.p_message).not.toContain('abcdef123456');
    expect(args.p_context).toEqual({ stage: 'inbound', apiKey: '[redacted]', text: '[not stored]' });
    expect(args.p_fingerprint).toMatch(/^[0-9a-f]{32}$/);
  });

  it('still prints to the console', async () => {
    await logError('x', new Error('e'));
    expect(console.error).toHaveBeenCalled();
  });

  it('uses console.warn and level warning for warnings', async () => {
    await logError('x', new Error('e'), { level: 'warning' });
    expect(console.warn).toHaveBeenCalled();
    expect(h.rpc.mock.calls[0][1].p_level).toBe('warning');
  });

  it('never throws when the database call fails or rejects', async () => {
    h.rpc.mockResolvedValueOnce({ error: { message: 'db down' } });
    await expect(logError('a', new Error('one'))).resolves.toBeUndefined();
    h.rpc.mockRejectedValueOnce(new Error('network'));
    await expect(logError('b', new Error('two'))).resolves.toBeUndefined();
  });

  it('does nothing against the database when the service key is missing', async () => {
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', '');
    await logError('x', new Error('e'));
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it('writes the same problem at most 3 times a minute per instance', async () => {
    for (let i = 0; i < 6; i++) await logError('loop', new Error('same problem'));
    expect(h.rpc).toHaveBeenCalledTimes(3);
  });
});

describe('allowWrite / fingerprintFor', () => {
  it('opens a new window after a minute', () => {
    for (let i = 0; i < 3; i++) expect(allowWrite('fp', 1000)).toBe(true);
    expect(allowWrite('fp', 1500)).toBe(false);
    expect(allowWrite('fp', 1000 + 61_000)).toBe(true);
  });

  it('is stable for the same problem and differs by source', () => {
    const a = fingerprintFor('s1', 'doc 1 failed', null);
    expect(fingerprintFor('s1', 'doc 2 failed', null)).toBe(a);
    expect(fingerprintFor('s2', 'doc 1 failed', null)).not.toBe(a);
  });
});
