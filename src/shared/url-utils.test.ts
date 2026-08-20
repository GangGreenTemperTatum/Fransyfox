import { describe, expect, test } from 'vitest';

import './url-utils';

describe('shared/url-utils', () => {
  test('cleans URL by preserving query params but removing fragment', () => {
    const utils = (globalThis as { FransceiverUrlUtils?: { cleanUrl: (url: string) => string } }).FransceiverUrlUtils;
    expect(utils?.cleanUrl('https://example.com/path?a=1#b')).toBe('https://example.com/path?a=1');
    expect(utils?.cleanUrl('https://example.com/path?a=1')).toBe('https://example.com/path?a=1');
    expect(utils?.cleanUrl('https://example.com/path#frag')).toBe('https://example.com/path');
    expect(utils?.cleanUrl('https://example.com/path')).toBe('https://example.com/path');
  });

  test('extracts JS URL from stack trace', () => {
    const utils = (globalThis as {
      FransceiverUrlUtils?: { extractJsUrlFromStack: (stack?: string, fullstack?: string[]) => string | null };
    }).FransceiverUrlUtils;

    const fullstack = ['at fn (https://example.com/app.js:10:22)'];
    expect(utils?.extractJsUrlFromStack(undefined, fullstack)).toBe('https://example.com/app.js');
  });
});
