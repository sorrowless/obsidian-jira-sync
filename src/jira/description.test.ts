import { describe, expect, it } from 'vitest';
import { descriptionToPlainText, plainTextToAdf } from './description';

describe('Jira description conversion', () => {
  it('returns plain strings unchanged (normalized newlines)', () => {
    expect(descriptionToPlainText('Hello\r\nworld')).toBe('Hello\nworld');
  });

  it('converts ADF documents to plain text with paragraph breaks', () => {
    const adf = plainTextToAdf('Line one\nLine two');
    const plain = descriptionToPlainText(adf);
    expect(plain).toBe('Line one\nLine two');
  });

  it('handles empty and null inputs', () => {
    expect(descriptionToPlainText(null)).toBe('');
    expect(descriptionToPlainText(undefined)).toBe('');
    expect(descriptionToPlainText('')).toBe('');
    expect(descriptionToPlainText(plainTextToAdf(''))).toBe('');
  });

  it('round-trips multi-line text through ADF', () => {
    const original = 'Alpha\n\nBeta';
    const adf = plainTextToAdf(original);
    expect(adf.type).toBe('doc');
    expect(descriptionToPlainText(adf)).toBe('Alpha\n\nBeta');
  });

  it('extracts text nodes from nested ADF structures', () => {
    const adf = {
      type: 'doc',
      version: 1,
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'Hello' }],
        },
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Line' },
            { type: 'hardBreak' },
            { type: 'text', text: 'break' },
          ],
        },
      ],
    };
    expect(descriptionToPlainText(adf)).toBe('Hello\nLine\nbreak');
  });
});
