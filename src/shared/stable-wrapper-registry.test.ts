import { describe, expect, test, vi } from 'vitest';

import { createStableWrapperRegistry } from './stable-wrapper-registry';

type Listener = (value: string) => string;

describe('shared/stable-wrapper-registry', () => {
  test('returns one wrapper for repeated registration of an identity', () => {
    const registry = createStableWrapperRegistry<Listener>((delegate) => (value) => delegate(value));
    const listener = vi.fn((value: string) => value.toUpperCase());

    const first = registry.getOrCreate(listener);
    const second = registry.getOrCreate(listener);

    expect(second).toBe(first);
    expect(first('ok')).toBe('OK');
    expect(listener).toHaveBeenCalledOnce();
  });

  test('resolves the original identity for removeEventListener', () => {
    const registry = createStableWrapperRegistry<Listener>((delegate) => (value) => delegate(value));
    const listener = (value: string) => value;
    const wrapped = registry.getOrCreate(listener);

    expect(registry.resolve(listener)).toBe(wrapped);
    expect(registry.resolve(wrapped)).toBe(wrapped);
    expect(registry.resolve((value) => value)).not.toBe(wrapped);
  });

  test('can key an unwrapped delegate by the page-visible listener', () => {
    const registry = createStableWrapperRegistry<Listener>((delegate) => (value) => delegate(value));
    const pageListener = () => 'outer';
    const unwrappedDelegate = () => 'inner';

    const wrapped = registry.getOrCreate(pageListener, unwrappedDelegate);

    expect(wrapped('value')).toBe('inner');
    expect(registry.resolve(pageListener)).toBe(wrapped);
  });

  test('preserves EventTarget dedupe and removal semantics', () => {
    type EventListener = (event: Event) => void;
    const registry = createStableWrapperRegistry<EventListener>((delegate) => (event) => delegate(event));
    const target = new EventTarget();
    const listener = vi.fn((event: Event) => void event);
    const wrapped = registry.getOrCreate(listener);

    target.addEventListener('message', wrapped);
    target.addEventListener('message', registry.getOrCreate(listener));
    target.dispatchEvent(new Event('message'));
    expect(listener).toHaveBeenCalledOnce();

    target.removeEventListener('message', registry.resolve(listener));
    target.dispatchEvent(new Event('message'));
    expect(listener).toHaveBeenCalledOnce();
  });
});
