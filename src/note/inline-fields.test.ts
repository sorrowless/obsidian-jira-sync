import { describe, expect, it } from 'vitest';
import {
  formatUnknownInlineFieldsSuffix,
  parseUnknownInlineFields,
} from './inline-fields';

describe('unknown inline fields', () => {
  it('captures unknown Dataview fields and leaves known keys out', () => {
    const parsed = parseUnknownInlineFields(
      '[ytracker:: CL-1] [foo:: bar baz] leftover',
    );
    expect(parsed.unknownInlineFields).toEqual(['[ytracker:: CL-1]', '[foo:: bar baz]']);
    expect(parsed.remainder).toBe('leftover');
  });

  it('formats preserved fields back', () => {
    expect(formatUnknownInlineFieldsSuffix(['[ytracker:: CL-1]', '[foo:: x]'])).toBe(
      ' [ytracker:: CL-1] [foo:: x]',
    );
  });
});
