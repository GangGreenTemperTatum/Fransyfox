import { describe, expect, test } from 'vitest';

import { createMessageConsoleSnapshot } from './message-console-snapshot';

describe('shared/message-console-snapshot', () => {
  test('preserves the complete captured data text and message metadata', () => {
    const dataText = 'x'.repeat(64 * 1024);
    const snapshot = createMessageConsoleSnapshot({
      kind: 'message',
      channel: 'window',
      origin: 'https://example.test',
      dataType: 'string',
      dataText,
      dataLength: dataText.length
    });

    expect(snapshot.dataText).toBe(dataText);
    expect(snapshot.dataLength).toBe(dataText.length);
    expect(snapshot.channel).toBe('window');
    expect(Object.isFrozen(snapshot)).toBe(true);
  });

  test('does not retain live or nested browser objects', () => {
    const liveEvent = { source: { window: true }, ports: [{ id: 1 }] };
    const snapshot = createMessageConsoleSnapshot({
      channel: 'port',
      dataText: '{"ok":true}',
      originalEvent: liveEvent,
      source: liveEvent.source,
      ports: liveEvent.ports
    });

    expect(snapshot).toEqual({ channel: 'port', dataText: '{"ok":true}' });
    expect('originalEvent' in snapshot).toBe(false);
    expect('source' in snapshot).toBe(false);
    expect('ports' in snapshot).toBe(false);
  });
});
