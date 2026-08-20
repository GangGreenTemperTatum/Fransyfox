import { describe, expect, test } from 'vitest';

import {
  isRuntimeAction,
  parseBridgeWindowMessage,
  parsePortRequestMessage,
  parsePortResponseMessage,
  parseRuntimeRequestMessage
} from './messages';

describe('contracts/messages', () => {
  test('parses runtime action messages', () => {
    const msg = parseRuntimeRequestMessage({ action: 'requestExtensionActive' });
    expect(msg).toBeTruthy();
    expect(isRuntimeAction(msg, 'requestExtensionActive')).toBe(true);
  });

  test('parses runtime event payload message', () => {
    const msg = parseRuntimeRequestMessage({ eventType: 'postMessage', event: { foo: 'bar' } });
    expect(msg).toBeTruthy();
  });

  test('parses runtime listener payload message', () => {
    const msg = parseRuntimeRequestMessage({
      listener: 'function handler() {}',
      stack: 'at handler (https://example.com/app.js:10:2)',
      domain: 'example.com'
    });
    expect(msg).toBeTruthy();
  });

  test('rejects unknown runtime action', () => {
    const msg = parseRuntimeRequestMessage({ action: 'unknown' });
    expect(msg).toBeNull();
  });

  test('parses known port request type', () => {
    const msg = parsePortRequestMessage({ type: 'REQUEST_STATE' });
    expect(msg).toEqual({ type: 'REQUEST_STATE' });
  });

  test('normalizes legacy state response shape', () => {
    const msg = parsePortResponseMessage({ listeners: {}, currentUrl: 'https://example.com' });
    expect(msg?.type).toBe('STATE');
  });

  test('parses event append and clear responses', () => {
    const append = parsePortResponseMessage({
      type: 'EVENTS_APPEND',
      events: [{ id: 1 }],
      timestamp: 1,
      fromVersion: 0,
      version: 1,
      maxEvents: 5000
    });
    expect(append?.type).toBe('EVENTS_APPEND');

    const cleared = parsePortResponseMessage({
      type: 'EVENTS_CLEARED',
      timestamp: 1,
      reason: 'navigation',
      tabId: 10,
      version: 2
    });
    expect(cleared?.type).toBe('EVENTS_CLEARED');
  });

  test('parses bridge tracker message', () => {
    const msg = parseBridgeWindowMessage({ type: 'FRANSYFOX_SETTINGS', detail: {} });
    expect(msg).toBeTruthy();
  });

  test('keeps listener payload contract across main -> bridge -> background', () => {
    const listenerDetail = {
      window: 'top',
      hops: 'top',
      domain: 'example.com',
      stack: 'at handler (https://example.com/app.js:12:9)',
      fullstack: ['Error', 'at handler (https://example.com/app.js:12:9)'],
      listener: 'function handler(event) { return event && event.data; }'
    };

    const bridgeMsg = parseBridgeWindowMessage({
      type: 'FRANSYFOX_DATA',
      detail: listenerDetail
    });
    expect(bridgeMsg).toBeTruthy();
    if (!bridgeMsg || !('detail' in bridgeMsg)) {
      throw new Error('bridge message parse unexpectedly failed');
    }

    // bridge forwards detail directly to background via chrome.runtime.sendMessage.
    const runtimeMsg = parseRuntimeRequestMessage(bridgeMsg.detail);
    expect(runtimeMsg).toBeTruthy();
    expect((runtimeMsg as { listener?: string }).listener).toBe(listenerDetail.listener);
  });
});
