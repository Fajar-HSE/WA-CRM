import { describe, expect, it } from 'vitest';
import {
  cleanMessage,
  cleanStack,
  normalizeForFingerprint,
  sanitizeContext,
  scrubText,
  topFrame,
} from './sanitize';

describe('scrubText', () => {
  it('masks bearer tokens, jwts and provider keys', () => {
    const out = scrubText(
      'Authorization: Bearer abcdefghijklmnop1234 and sk-proj-ABCDEFGHIJKLMNOP and eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.SflKxwRJSMeKKF2QT4',
    );
    expect(out).not.toContain('abcdefghijklmnop1234');
    expect(out).not.toContain('sk-proj-ABCDEFGHIJKLMNOP');
    expect(out).not.toContain('eyJhbGciOiJIUzI1');
  });

  it('masks key=value pairs with secret-looking names', () => {
    expect(scrubText('failed api_key=SuperSecret99 end')).not.toContain('SuperSecret99');
    expect(scrubText('{"password":"hunter2222"}')).not.toContain('hunter2222');
  });

  it('drops query strings, emails and phone numbers', () => {
    const out = scrubText(
      'GET https://x.test/hook?token=abc123&b=2 for ani@example.com phone 6281234567890',
    );
    expect(out).toContain('https://x.test/hook?[query]');
    expect(out).not.toContain('abc123');
    expect(out).not.toContain('ani@example.com');
    expect(out).not.toContain('6281234567890');
  });

  it('keeps ordinary text', () => {
    expect(scrubText('document 12 failed to index')).toBe('document 12 failed to index');
  });
});

describe('cleanMessage / cleanStack', () => {
  it('handles errors, strings and objects', () => {
    expect(cleanMessage(new Error('boom'))).toBe('boom');
    expect(cleanMessage('plain')).toBe('plain');
    expect(cleanMessage({ code: 1 })).toBe('{"code":1}');
  });

  it('truncates very long messages', () => {
    expect(cleanMessage('x'.repeat(5000)).length).toBeLessThanOrEqual(2001);
  });

  it('returns null for a non-error stack', () => {
    expect(cleanStack('nope')).toBeNull();
    expect(cleanStack(new Error('e'))).toContain('Error');
  });
});

describe('sanitizeContext', () => {
  it('redacts secret keys and never keeps message content', () => {
    const out = sanitizeContext({
      accountId: 'a1',
      apiKey: 'sk-live-123456789012',
      Authorization: 'Bearer zzzzzzzzzzzz',
      text: 'halo, ini pesan pelanggan',
      body: { x: 1 },
      nested: { token: 'abc', ok: true },
    });
    expect(out.accountId).toBe('a1');
    expect(out.apiKey).toBe('[redacted]');
    expect(out.Authorization).toBe('[redacted]');
    expect(out.text).toBe('[not stored]');
    expect(out.body).toBe('[not stored]');
    expect(out.nested).toEqual({ token: '[redacted]', ok: true });
  });

  it('limits depth, array length and string length', () => {
    const deep = { a: { b: { c: { d: { e: 1 } } } } };
    expect(JSON.stringify(sanitizeContext(deep))).toContain('[too deep]');
    const out = sanitizeContext({ list: Array.from({ length: 50 }, (_, i) => i), s: 'y'.repeat(900) });
    expect((out.list as unknown[]).length).toBe(20);
    expect((out.s as string).length).toBeLessThanOrEqual(501);
  });

  it('returns an empty object for non-objects', () => {
    expect(sanitizeContext('x')).toEqual({});
    expect(sanitizeContext(null)).toEqual({});
    expect(sanitizeContext([1, 2])).toEqual({});
  });
});

describe('fingerprint helpers', () => {
  it('groups messages that differ only by numbers, ids and quoted values', () => {
    expect(normalizeForFingerprint('doc 12 failed')).toBe(normalizeForFingerprint('doc 98 failed'));
    expect(
      normalizeForFingerprint('row 3f2a1b4c-1111-2222-3333-444455556666 missing'),
    ).toBe(normalizeForFingerprint('row 9a8b7c6d-1111-2222-3333-444455556666 missing'));
    expect(normalizeForFingerprint('bad value "abc"')).toBe(normalizeForFingerprint('bad value "xyz"'));
  });

  it('takes the first own-code stack frame without line numbers', () => {
    const stack = [
      'Error: x',
      '    at node_modules/lib/a.js:1:2',
      '    at doThing (/app/src/foo.ts:10:5)',
    ].join('\n');
    expect(topFrame(stack)).toBe('at doThing (/app/src/foo.ts');
    expect(topFrame(null)).toBe('');
  });
});
