import { describe, expect, test } from 'vitest';

import {
  DEFAULT_CAPTURE_LIMIT_CHARS,
  HARD_CAPTURE_LIMIT_CHARS,
  getEffectiveCaptureLimit,
  serializeForCapture
} from './capture-serializer';

describe('shared/capture-serializer', () => {
  test('uses a safe default and clamps configured limits', () => {
    expect(getEffectiveCaptureLimit(0)).toBe(DEFAULT_CAPTURE_LIMIT_CHARS);
    expect(getEffectiveCaptureLimit(-1)).toBe(DEFAULT_CAPTURE_LIMIT_CHARS);
    expect(getEffectiveCaptureLimit(4096)).toBe(4096);
    expect(getEffectiveCaptureLimit(HARD_CAPTURE_LIMIT_CHARS * 2)).toBe(HARD_CAPTURE_LIMIT_CHARS);
  });

  test('slices strings without serializing them first', () => {
    const result = serializeForCapture('x'.repeat(10_000), 1024);
    expect(result.dataText).toHaveLength(1024);
    expect(result.dataTruncated).toBe(true);
    expect(result.dataLength).toBe(10_000);
  });

  test('aborts serialization when an object exceeds the budget', () => {
    const result = serializeForCapture({ values: Array.from({ length: 10_000 }, (_, i) => `value-${i}`) }, 2048);
    expect(result.dataTruncated).toBe(true);
    expect(result.dataText?.length).toBeLessThan(2048);
  });

  test('preserves ordinary JSON payloads', () => {
    expect(serializeForCapture({ ok: true, count: 2 }, 4096)).toEqual({
      dataType: 'object',
      dataText: '{"ok":true,"count":2}'
    });
  });
});
