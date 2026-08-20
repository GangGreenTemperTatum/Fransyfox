(() => {
  'use strict';

  const LEVELS = {
    debug: 0,
    info: 1,
    warn: 2,
    error: 3
  } as const;

  type LevelName = keyof typeof LEVELS;

  let currentLevel: number = LEVELS.debug;

  function shouldPrefix(args: unknown[]): boolean {
    if (!args || args.length === 0) return true;
    const first = args[0];
    return !(typeof first === 'string' && first.startsWith('Fransceiver'));
  }

  function emit(levelName: LevelName, scope: string | undefined, args: unknown[]): void {
    const method = (console[levelName] || console.log).bind(console);
    if (LEVELS[levelName] < currentLevel) return;

    if (shouldPrefix(args)) {
      const prefix = scope ? `Fransceiver:${scope}` : 'Fransceiver';
      method(`[${prefix}]`, ...args);
      return;
    }

    method(...args);
  }

  function scoped(scope?: string) {
    return {
      debug: (...args: unknown[]) => emit('debug', scope, args),
      info: (...args: unknown[]) => emit('info', scope, args),
      warn: (...args: unknown[]) => emit('warn', scope, args),
      error: (...args: unknown[]) => emit('error', scope, args)
    };
  }

  function setLevel(levelName: string): void {
    if (Object.prototype.hasOwnProperty.call(LEVELS, levelName)) {
      currentLevel = LEVELS[levelName as LevelName];
    }
  }

  type FransceiverLoggerType = {
    scoped: typeof scoped;
    setLevel: typeof setLevel;
  };

  const globalObj = globalThis as typeof globalThis & {
    FransceiverLogger?: Partial<FransceiverLoggerType>;
  };

  globalObj.FransceiverLogger = Object.assign(globalObj.FransceiverLogger || {}, {
    scoped,
    setLevel
  });
})();
