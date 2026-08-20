import { describe, expect, test } from 'vitest';

import { compileBlacklist, hasExtensionUrl, matchesBlacklistText } from './blacklist-matcher';

const TOKENS = [
  'wappalyzer',
  'react-devtools',
  'domlogger',
  'POSTMESSAGE_TRACKER_DATA',
  'Fransyfox:',
  '__postmessagetrackername__'
];

// The original implementation, kept here as the behavioral reference.
function legacyMatches(tokens: string[], value: string, includeExtensionUrl = true): boolean {
  if (includeExtensionUrl && /\b(?:chrome|moz)-extension:\/\/[a-z0-9-]{8,}/i.test(value)) {
    return true;
  }
  const normalize = (input: string) => input.toLowerCase().replace(/[^a-z0-9]+/g, '');
  const lower = value.toLowerCase();
  const compact = normalize(value);
  for (const token of tokens) {
    if (lower.includes(token.toLowerCase())) return true;
    const tokenCompact = normalize(token);
    if (tokenCompact && compact.includes(tokenCompact)) return true;
  }
  return false;
}

describe('shared/blacklist-matcher', () => {
  const compiled = compileBlacklist(TOKENS);

  test('matches plain tokens', () => {
    expect(matchesBlacklistText(compiled, 'sent by wappalyzer extension')).toBe(true);
    expect(matchesBlacklistText(compiled, 'domlogger payload')).toBe(true);
  });

  test('matches case variants', () => {
    expect(matchesBlacklistText(compiled, 'WAPPALYZER')).toBe(true);
    expect(matchesBlacklistText(compiled, 'Postmessage_Tracker_Data')).toBe(true);
  });

  test('matches separator-obfuscated occurrences (compact semantics)', () => {
    expect(matchesBlacklistText(compiled, 'wappa-lyzer')).toBe(true);
    expect(matchesBlacklistText(compiled, 'react devtools hook')).toBe(true);
    expect(matchesBlacklistText(compiled, 'POST.MESSAGE TRACKER-DATA')).toBe(true);
  });

  test('matches tokens containing regex-special characters', () => {
    const special = compileBlacklist(['weird.token+name']);
    expect(matchesBlacklistText(special, 'prefix weird.token+name suffix')).toBe(true);
    expect(matchesBlacklistText(special, 'weird_token_name')).toBe(true);
  });

  test('does not match unrelated strings', () => {
    expect(matchesBlacklistText(compiled, 'hello world')).toBe(false);
    expect(matchesBlacklistText(compiled, JSON.stringify({ type: 'app-event', n: 1 }))).toBe(false);
    expect(matchesBlacklistText(compiled, '')).toBe(false);
  });

  test('extension URL detection honors includeExtensionUrl flag', () => {
    const url = 'chrome-extension://abcdefghijklmnop/script.js';
    expect(matchesBlacklistText(compiled, url, true)).toBe(true);
    expect(matchesBlacklistText(compiled, url, false)).toBe(false);
    expect(hasExtensionUrl(url)).toBe(true);
    expect(hasExtensionUrl('https://example.com')).toBe(false);
  });

  test('empty blacklist matches nothing except extension URLs', () => {
    const empty = compileBlacklist([]);
    expect(matchesBlacklistText(empty, 'wappalyzer')).toBe(false);
    expect(matchesBlacklistText(empty, 'chrome-extension://abcdefghijklmnop/x.js')).toBe(true);
  });

  test('equivalent to legacy matcher across a corpus', () => {
    const corpus = [
      'wappalyzer',
      'Wappa Lyzer says hi',
      'wappa~!~lyzer',
      'Fransyfox: initialized',
      'fransytracker initialized',
      '__postmessagetrackername__',
      'post message tracker name',
      'regular message payload',
      '{"type":"POSTMESSAGE_TRACKER_DATA","detail":{}}',
      '{"type":"app-data","items":[1,2,3]}',
      'react-devtools-bridge',
      'reactdevtools',
      'react devtoolsy',
      'chrome-extension://abcdefgh1234/page.js',
      'moz-extension://some-addon-id/bg.js',
      'at https://example.com/app.js:10:5',
      ''
    ];
    for (const value of corpus) {
      for (const includeUrl of [true, false]) {
        expect(matchesBlacklistText(compiled, value, includeUrl), `value=${JSON.stringify(value)} includeUrl=${includeUrl}`).toBe(
          legacyMatches(TOKENS, value, includeUrl)
        );
      }
    }
  });
});
