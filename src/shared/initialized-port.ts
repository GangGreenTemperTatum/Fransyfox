export interface PortEvent<T> {
  addListener(listener: T): void;
}

export interface InitializedPort {
  onMessage: PortEvent<(message: unknown) => void>;
  onDisconnect: PortEvent<() => void>;
}

export interface InitializedPortHandlers {
  onConnected: () => boolean | void;
  onMessage: (message: unknown) => Promise<boolean | void> | boolean | void;
  onDisconnected: () => void;
  onError: (error: unknown) => void;
}

/**
 * Registers both port listeners before startup completes, then admits only
 * live ports and messages once the startup barrier resolves.
 */
export function registerInitializedPort(
  port: InitializedPort,
  initialized: Promise<unknown>,
  handlers: InitializedPortHandlers
): void {
  let disconnected = false;
  let connected = false;

  function disconnect(): void {
    if (disconnected) return;
    disconnected = true;
    if (connected) handlers.onDisconnected();
  }

  function runAfterInitialization(operation: () => Promise<boolean | void> | boolean | void): void {
    void initialized
      .then(async () => {
        if (disconnected) return;
        return operation();
      })
      .then((result) => {
        if (result === false) disconnect();
      })
      .catch((error: unknown) => {
        disconnect();
        handlers.onError(error);
      });
  }

  port.onDisconnect.addListener(disconnect);
  port.onMessage.addListener((message) => {
    runAfterInitialization(() => handlers.onMessage(message));
  });
  runAfterInitialization(() => {
    connected = true;
    return handlers.onConnected();
  });
}
