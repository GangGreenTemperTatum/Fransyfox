import { describe, expect, test } from 'vitest';

import './messages';

describe('shared/messages', () => {
  test('exposes port message constants', () => {
    const messages = (globalThis as { FransyfoxMessages?: { PORT?: Record<string, string> } }).FransyfoxMessages;
    expect(messages?.PORT?.REQUEST_STATE).toBe('REQUEST_STATE');
    expect(messages?.PORT?.EVENTS_APPEND).toBe('EVENTS_APPEND');
    expect(messages?.PORT?.EVENTS_CLEARED).toBe('EVENTS_CLEARED');
  });
});
