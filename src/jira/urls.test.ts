import { describe, expect, it } from 'vitest';
import {
  extractIssueKeyFromUrl,
  issueBrowseUrl,
  isIssueKey,
  normalizeBaseUrl,
  parseMarkdownLink,
} from './urls';

describe('jira urls', () => {
  it('normalizes base url', () => {
    expect(normalizeBaseUrl('https://jira.example/')).toBe('https://jira.example');
  });

  it('builds browse urls', () => {
    expect(issueBrowseUrl('https://jira.example', 'proj-12')).toBe(
      'https://jira.example/browse/PROJ-12',
    );
  });

  it('extracts issue keys from browse urls', () => {
    expect(
      extractIssueKeyFromUrl('https://jira.example/browse/PROJ-12?foo=1', 'https://jira.example'),
    ).toBe('PROJ-12');
    expect(
      extractIssueKeyFromUrl('https://other.example/browse/PROJ-12', 'https://jira.example'),
    ).toBeNull();
  });

  it('validates issue keys', () => {
    expect(isIssueKey('PROJ-1')).toBe(true);
    expect(isIssueKey('not-a-key')).toBe(false);
  });

  it('parses markdown links', () => {
    expect(parseMarkdownLink('[Title](https://x/browse/A-1)')).toEqual({
      title: 'Title',
      url: 'https://x/browse/A-1',
    });
  });

  it('parses markdown links whose title contains brackets', () => {
    expect(
      parseMarkdownLink('[[not-fix some task]](https://jira.example/browse/PROJ-1)'),
    ).toEqual({
      title: '[not-fix some task]',
      url: 'https://jira.example/browse/PROJ-1',
    });
    expect(
      parseMarkdownLink('[[[nested]]](https://jira.example/browse/PROJ-2)'),
    ).toEqual({
      title: '[[nested]]',
      url: 'https://jira.example/browse/PROJ-2',
    });
  });
});
