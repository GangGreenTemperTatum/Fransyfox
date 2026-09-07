import { describe, expect, test, vi } from 'vitest';

import { registerInitializedPort } from './initialized-port';

class FakePort {
  private readonly messageListeners: Array<(message: unknown) => void> = [];
  private readonly disconnectListeners: Array<() => void> = [];

  readonly onMessage = {
    addListener: (listener: (message: unknown) => void) => {
      this.messageListeners.push(listener);
    }
  };

  readonly onDisconnect = {
    addListener: (listener: () => void) => {
      this.disconnectListeners.push(listener);
    }
  };

  emitMessage(message: unknown): void {
    this.messageListeners.forEach((listener) => listener(message));
  }

  emitDisconnect(): void {
    this.disconnectListeners.forEach((listener) => listener());
  }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await Promise.resolve();
  }
}

describe('registerInitializedPort', () => {
  test('does not retain or dispatch a port disconnected before initialization', async () => {
    const ready = deferred();
    const port = new FakePort();
    const onConnected = vi.fn();
    const onMessage = vi.fn();
    const onDisconnected = vi.fn();

    registerInitializedPort(port, ready.promise, {
      onConnected,
      onMessage,
      onDisconnected,
      onError: vi.fn()
    });

    port.emitMessage({ type: 'REQUEST_STATE' });
    port.emitDisconnect();
    ready.resolve();
    await settle();

    expect(onConnected).not.toHaveBeenCalled();
    expect(onMessage).not.toHaveBeenCalled();
    expect(onDisconnected).not.toHaveBeenCalled();
  });

  test('admits a live port before dispatching an early request', async () => {
    const ready = deferred();
    const port = new FakePort();
    const order: string[] = [];

    registerInitializedPort(port, ready.promise, {
      onConnected: () => {
        order.push('hello');
      },
      onMessage: (message) => {
        order.push(`request:${String(message)}`);
      },
      onDisconnected: vi.fn(),
      onError: vi.fn()
    });

    port.emitMessage('state');
    ready.resolve();
    await settle();

    expect(order).toEqual(['hello', 'request:state']);
  });

  test('cleans up once and ignores later messages after a live port disconnects', async () => {
    const port = new FakePort();
    const onMessage = vi.fn();
    const onDisconnected = vi.fn();

    registerInitializedPort(port, Promise.resolve(), {
      onConnected: vi.fn(),
      onMessage,
      onDisconnected,
      onError: vi.fn()
    });
    await settle();

    port.emitDisconnect();
    port.emitDisconnect();
    port.emitMessage('late request');
    await settle();

    expect(onDisconnected).toHaveBeenCalledOnce();
    expect(onMessage).not.toHaveBeenCalled();
  });

  test('cleans up when the initial hello cannot be delivered', async () => {
    const port = new FakePort();
    const onDisconnected = vi.fn();

    registerInitializedPort(port, Promise.resolve(), {
      onConnected: () => false,
      onMessage: vi.fn(),
      onDisconnected,
      onError: vi.fn()
    });
    await settle();

    expect(onDisconnected).toHaveBeenCalledOnce();
  });

  test('keeps a live port connected after a non-fatal rejected request', async () => {
    const port = new FakePort();
    const onDisconnected = vi.fn();

    registerInitializedPort(port, Promise.resolve(), {
      onConnected: vi.fn(),
      onMessage: () => true,
      onDisconnected,
      onError: vi.fn()
    });
    await settle();

    port.emitMessage('rejected request');
    await settle();

    expect(onDisconnected).not.toHaveBeenCalled();
  });

  test('reports and cleans up handler failures', async () => {
    const port = new FakePort();
    const failure = new Error('request failed');
    const onError = vi.fn();
    const onDisconnected = vi.fn();

    registerInitializedPort(port, Promise.resolve(), {
      onConnected: vi.fn(),
      onMessage: () => {
        throw failure;
      },
      onDisconnected,
      onError
    });
    await settle();

    port.emitMessage('request');
    await settle();

    expect(onDisconnected).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith(failure);
  });
});
