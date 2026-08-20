import { describe, expect, test } from 'vitest';

import {
  normalizeBoolean,
  normalizeListenerRecord,
  normalizeMessageFilterText,
  normalizePanelViewMode,
  normalizeMessageSortOrder,
  normalizeMatchReplaceRules,
  normalizeMessageDebugSettings,
  normalizeStringArray
} from './state';

describe('contracts/state', () => {
  test('normalizes booleans with fallback', () => {
    expect(normalizeBoolean(true, false)).toBe(true);
    expect(normalizeBoolean('x', false)).toBe(false);
  });

  test('normalizes string arrays', () => {
    expect(normalizeStringArray(['a', 1, 'b'])).toEqual(['a', 'b']);
  });

  test('normalizes rules shape', () => {
    expect(
      normalizeMatchReplaceRules([{ pattern: 'a', replacement: 'b' }, { pattern: 'x' }, null])
    ).toEqual([{ pattern: 'a', replacement: 'b' }]);
    expect(
      normalizeMatchReplaceRules([{ pattern: '(a+)+$', replacement: 'blocked' }])
    ).toEqual([]);
  });

  test('normalizes debug settings', () => {
    expect(normalizeMessageDebugSettings({ consoleLogEnabled: true })).toEqual({
      consoleLogEnabled: true,
      debugBreakEnabled: false,
      debugBreakMatch: '',
      maxCapturedMessageSize: 0
    });
    expect(normalizeMessageDebugSettings({ maxCapturedMessageSize: 4096.7 })).toMatchObject({
      maxCapturedMessageSize: 4096
    });
    expect(normalizeMessageDebugSettings({ maxCapturedMessageSize: -5 })).toMatchObject({
      maxCapturedMessageSize: 0
    });
    expect(normalizeMessageDebugSettings({ maxCapturedMessageSize: 999_999 })).toMatchObject({
      maxCapturedMessageSize: 262_144
    });
    expect(normalizeMessageDebugSettings({ debugBreakMatch: '(a+)+$' })).toMatchObject({
      debugBreakMatch: ''
    });
  });

  test('normalizes message filter text', () => {
    expect(normalizeMessageFilterText('abc')).toBe('abc');
    expect(normalizeMessageFilterText(123)).toBe('');
  });

  test('normalizes message sort order', () => {
    expect(normalizeMessageSortOrder('asc')).toBe('asc');
    expect(normalizeMessageSortOrder('desc')).toBe('desc');
    expect(normalizeMessageSortOrder('invalid')).toBe('desc');
  });

  test('normalizes panel view mode', () => {
    expect(normalizePanelViewMode('listeners')).toBe('listeners');
    expect(normalizePanelViewMode('messages')).toBe('messages');
    expect(normalizePanelViewMode('findings')).toBe('findings');
    expect(normalizePanelViewMode('match')).toBe('match');
    expect(normalizePanelViewMode('bad')).toBe('listeners');
  });

  test('normalizes listener record', () => {
    expect(normalizeListenerRecord({ listener: 'function(){}' })).toEqual({ listener: 'function(){}' });
    expect(normalizeListenerRecord({})).toBeNull();
  });
});
