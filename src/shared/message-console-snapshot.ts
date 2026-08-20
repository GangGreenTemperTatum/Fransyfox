const MESSAGE_CONSOLE_FIELDS = [
  'kind',
  'channel',
  'sourceFrame',
  'targetFrame',
  'origin',
  'portsCount',
  'dataType',
  'dataText',
  'dataTruncated',
  'dataLength'
] as const;

type ConsoleScalar = string | number | boolean | null;

/**
 * Creates a detached, immutable console value containing only captured scalar
 * fields. In particular, no MessageEvent, Window, or MessagePort references
 * can be retained by DevTools.
 */
export function createMessageConsoleSnapshot(
  payload: Record<string, unknown>
): Readonly<Record<string, ConsoleScalar>> {
  const snapshot: Record<string, ConsoleScalar> = {};
  for (const field of MESSAGE_CONSOLE_FIELDS) {
    const value = payload[field];
    if (typeof value === 'string'
      || typeof value === 'number'
      || typeof value === 'boolean'
      || value === null) {
      snapshot[field] = value;
    }
  }
  return Object.freeze(snapshot);
}
