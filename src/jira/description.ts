/**
 * Convert Jira description payloads (plain string, wiki-ish text, or ADF) to plain text.
 */

export function descriptionToPlainText(value: unknown): string {
  if (value == null) {
    return '';
  }
  if (typeof value === 'string') {
    return normalizeNewlines(value);
  }
  if (typeof value === 'object' && value !== null && (value as { type?: string }).type === 'doc') {
    return normalizeNewlines(adfToPlainText(value as AdfNode));
  }
  return '';
}

/** Build a minimal ADF document from plain text (Cloud API v3). */
export function plainTextToAdf(text: string): AdfNode {
  const lines = (text ?? '').replace(/\r\n/g, '\n').split('\n');
  const content: AdfNode[] = [];
  for (const line of lines) {
    if (line.length === 0) {
      content.push({ type: 'paragraph' });
      continue;
    }
    content.push({
      type: 'paragraph',
      content: [{ type: 'text', text: line }],
    });
  }
  if (content.length === 0) {
    content.push({ type: 'paragraph' });
  }
  return { type: 'doc', version: 1, content };
}

interface AdfNode {
  type?: string;
  text?: string;
  version?: number;
  content?: AdfNode[];
  attrs?: Record<string, unknown>;
}

function adfToPlainText(node: AdfNode): string {
  if (!node) {
    return '';
  }
  if (node.type === 'text') {
    return node.text ?? '';
  }
  if (node.type === 'hardBreak') {
    return '\n';
  }
  const children = (node.content ?? []).map(adfToPlainText).join('');
  if (
    node.type === 'paragraph' ||
    node.type === 'heading' ||
    node.type === 'bulletList' ||
    node.type === 'orderedList' ||
    node.type === 'listItem' ||
    node.type === 'blockquote' ||
    node.type === 'codeBlock'
  ) {
    return children.endsWith('\n') ? children : `${children}\n`;
  }
  return children;
}

function normalizeNewlines(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\n+$/u, '');
}
