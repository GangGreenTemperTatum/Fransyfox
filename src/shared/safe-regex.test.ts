import { describe, expect, test } from 'vitest';

import {
  MAX_USER_REGEX_INPUT_CHARS,
  MAX_USER_REGEX_PATTERN_CHARS,
  compileSafeRegex,
  getRegexSafetyError,
  limitRegexInput
} from './safe-regex';

describe('shared/safe-regex', () => {
  test.each([
    'https?://[^\\s"\'<>)]+',
    '^message\\.(data|origin)$',
    'token-[a-z0-9]{1,64}',
    'foo.*bar'
  ])('accepts bounded common pattern %s', (pattern) => {
    expect(compileSafeRegex(pattern, 'gi')).toEqual({
      regex: new RegExp(pattern, 'gi'),
      error: null
    });
  });

  test.each([
    '(a+)+$',
    '(a|aa)+$',
    '(\\w+\\s?)*$',
    '(?=a)+',
    '(?=.*token)',
    '(a)\\1',
    'a{1,10001}',
    'a+a+$',
    '(a+)a+$',
    '.*.*token',
    '[a-z]+[a-z]+'
  ])('rejects potentially nonlinear pattern %s', (pattern) => {
    expect(getRegexSafetyError(pattern)).toBeTruthy();
    expect(compileSafeRegex(pattern).regex).toBeNull();
  });

  test('rejects invalid and oversized patterns', () => {
    expect(compileSafeRegex('[').regex).toBeNull();
    expect(getRegexSafetyError('x'.repeat(MAX_USER_REGEX_PATTERN_CHARS + 1))).toContain('exceeds');
  });

  test('bounds inspected input without changing shorter text', () => {
    const long = 'x'.repeat(MAX_USER_REGEX_INPUT_CHARS + 100);
    expect(limitRegexInput(long)).toHaveLength(MAX_USER_REGEX_INPUT_CHARS);
    expect(limitRegexInput('short')).toBe('short');
  });
});
