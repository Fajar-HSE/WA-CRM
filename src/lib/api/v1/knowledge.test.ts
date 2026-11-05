import { describe, expect, it } from 'vitest';
import {
  KB_CONTENT_MAX,
  KB_TITLE_MAX,
  KnowledgeInputError,
  parseContent,
  parseTitle,
  serializeKnowledge,
} from './knowledge';

describe('parseTitle / parseContent', () => {
  it('trims and accepts valid text', () => {
    expect(parseTitle('  Hi ', true)).toBe('Hi');
    expect(parseContent(' body\n', true)).toBe('body');
  });
  it('returns undefined for an absent optional field', () => {
    expect(parseTitle(undefined, false)).toBeUndefined();
    expect(parseContent(undefined, false)).toBeUndefined();
  });
  it('rejects absent required, blank, non-string and oversized values', () => {
    expect(() => parseTitle(undefined, true)).toThrow(KnowledgeInputError);
    expect(() => parseTitle('   ', false)).toThrow(KnowledgeInputError);
    expect(() => parseContent(12, false)).toThrow(KnowledgeInputError);
    expect(() => parseTitle('a'.repeat(KB_TITLE_MAX + 1), true)).toThrow(/at most/);
    expect(() => parseContent('a'.repeat(KB_CONTENT_MAX + 1), true)).toThrow(/split it/);
    expect(parseContent('a'.repeat(KB_CONTENT_MAX), true)).toHaveLength(KB_CONTENT_MAX);
  });
});

describe('serializeKnowledge', () => {
  it('drops unknown columns and omits content when absent', () => {
    const row = {
      id: '1', title: 't', created_at: 'c', updated_at: 'u', account_id: 'secret',
    } as never;
    const out = serializeKnowledge(row);
    expect(out).toEqual({ id: '1', title: 't', created_at: 'c', updated_at: 'u' });
  });
});
