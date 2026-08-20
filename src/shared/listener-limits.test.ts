import { describe, expect, test } from 'vitest';

import {
  MAX_LISTENER_FULLSTACK_LINE_CHARS,
  MAX_LISTENER_FULLSTACK_LINES,
  MAX_LISTENER_SOURCE_CHARS,
  MAX_LISTENER_STACK_CHARS,
  captureListenerSource,
  sanitizeListenerRecord,
  selectListenerEvictionIndex
} from './listener-limits';
import type { ListenerRecord } from '../types/listener';

describe('shared/listener-limits', () => {
  test('captures a compact source and stable identity', () => {
    const source = `function listener() { return '${'x'.repeat(20_000)}'; }`;
    const first = captureListenerSource(source);
    const second = captureListenerSource(source);

    expect(first.text).toHaveLength(MAX_LISTENER_SOURCE_CHARS);
    expect(first.length).toBe(source.length);
    expect(first.truncated).toBe(true);
    expect(first.hash).toBe(second.hash);
  });

  test('bounds persisted source and stack fields', () => {
    const listener: ListenerRecord = {
      listener: 'x'.repeat(20_000),
      stack: 's'.repeat(10_000),
      fullstack: Array.from({ length: 50 }, () => 'f'.repeat(2_000)),
      unexpectedPayload: 'z'.repeat(20_000)
    };

    expect(sanitizeListenerRecord(listener, 123)).toBe(true);
    expect(listener.listener).toHaveLength(MAX_LISTENER_SOURCE_CHARS);
    expect(listener.listenerLength).toBe(20_000);
    expect(listener.listenerTruncated).toBe(true);
    expect(listener.listenerCaptureHash).toMatch(/^[0-9a-f]{8}$/);
    expect(listener.stack).toHaveLength(MAX_LISTENER_STACK_CHARS);
    expect(listener.fullstack).toHaveLength(MAX_LISTENER_FULLSTACK_LINES);
    expect(listener.fullstack?.[0]).toHaveLength(MAX_LISTENER_FULLSTACK_LINE_CHARS);
    expect(listener.capturedAt).toBe(123);
    expect(listener.unexpectedPayload).toBeUndefined();
  });

  test('evicts stale history before active listeners', () => {
    const listeners = [
      { listener: 'active-old', capturedAt: 1 },
      { listener: 'stale-new', capturedAt: 3, stale: true },
      { listener: 'stale-old', capturedAt: 2, stale: true }
    ];
    expect(selectListenerEvictionIndex(listeners)).toBe(2);
  });

  test('evicts the oldest active listener when there is no stale history', () => {
    const listeners = [
      { listener: 'new', capturedAt: 20 },
      { listener: 'old', capturedAt: 10 }
    ];
    expect(selectListenerEvictionIndex(listeners)).toBe(1);
  });
});
