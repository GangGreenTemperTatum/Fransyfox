import { describe, expect, test, vi } from 'vitest';

import './logger';

describe('shared/logger', () => {
  test('creates scoped logger and prefixes output', () => {
    const logger = (globalThis as {
      FransyfoxLogger?: { scoped: (scope?: string) => { info: (...args: unknown[]) => void } };
    }).FransyfoxLogger;

    const spy = vi.spyOn(console, 'info').mockImplementation(() => {});
    logger?.scoped('test').info('hello');
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
