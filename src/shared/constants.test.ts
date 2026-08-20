import { describe, expect, test } from 'vitest';

import './constants';

describe('shared/constants', () => {
  test('registers constants on global namespace', () => {
    const constants = (globalThis as { FransceiverConstants?: Record<string, unknown> }).FransceiverConstants;
    expect(constants).toBeTruthy();
    expect(constants?.STORAGE_KEYS).toBeTruthy();
    expect(constants?.EXTENSION_BLACKLIST).toBeTruthy();
    const storageKeys = constants?.STORAGE_KEYS as Record<string, string> | undefined;
    expect(storageKeys?.MESSAGE_QUERY).toBe('messageQuery');
    expect(storageKeys?.MESSAGE_TARGET_FRAME).toBe('messageTargetFrame');
    expect(storageKeys?.MESSAGE_SORT_ORDER).toBe('messageSortOrder');
    expect(storageKeys?.MESSAGE_ALL_EXPANDED).toBe('messageAllExpanded');
    expect(storageKeys?.PANEL_VIEW_MODE).toBe('panelViewMode');
  });
});
