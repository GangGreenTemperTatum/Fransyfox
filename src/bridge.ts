import { parseBridgeWindowMessage, TRACKER_EVENT_TO_BRIDGE, TRACKER_EVENT_TO_MAIN } from './contracts/messages';
import { createTimedEventBatcher } from './shared/event-batcher';
import type { MatchReplaceRule, MessageDebugSettings } from './types/settings';

// Bridge Content Script - Handles communication between MAIN world and background
if (typeof window.FransyfoxBridgeLoaded === 'undefined') {
  window.FransyfoxBridgeLoaded = true;

  (function () {
    'use strict';

    function asRecord(value: unknown): Record<string, unknown> | null {
      if (typeof value !== 'object' || value === null) {
        return null;
      }
      return value as Record<string, unknown>;
    }

    // Import constants - bridge runs in ISOLATED world so we can access extension modules
    const DEFAULT_EXTENSION_BLACKLIST = [
      'wappalyzer',
      'react-devtools',
      'vue-devtools',
      'domlogger',
      'event-tracker',
      'event-tracker-page-hook',
      'event-tracker-content-hook',
      'bitwarden-webauthn',
      'FRANSYFOX_DATA',
      'Fransyfox:',
      'POSTMESSAGE_TRACKER_DATA',
      'FransyTracker:',
      '__postmessagetrackername__'
    ];
    const constants =
      typeof FransyfoxConstants !== 'undefined' && FransyfoxConstants
        ? FransyfoxConstants
        : null;

    const EXTENSION_BLACKLIST = Array.from(
      new Set([...(constants?.EXTENSION_BLACKLIST || []), ...DEFAULT_EXTENSION_BLACKLIST])
    );
    const STORAGE_KEYS = constants?.STORAGE_KEYS || { EXTENSION_ACTIVE: 'extensionActive' };
    const EXTENSION_ACTIVE_KEY = STORAGE_KEYS.EXTENSION_ACTIVE || 'extensionActive';
    const FLOOD_PROTECTION_KEY =
      (STORAGE_KEYS as Record<string, string>).FLOOD_PROTECTION_ENABLED || 'floodProtectionEnabled';

    const BLACKLIST_TYPE = 'FRANSYFOX_BLACKLIST';
    const RULES_TYPE = 'FRANSYFOX_RULES';
    const RULES_REQUEST_TYPE = 'FRANSYFOX_RULES_REQUEST';
    const SETTINGS_TYPE = 'FRANSYFOX_SETTINGS';
    const SETTINGS_REQUEST_TYPE = 'FRANSYFOX_SETTINGS_REQUEST';
    const ACTIVE_TYPE = 'FRANSYFOX_ACTIVE';
    const ACTIVE_REQUEST_TYPE = 'FRANSYFOX_ACTIVE_REQUEST';

    let bridgeActive = true;
    let trackingListenersAttached = false;

    let cachedMatchReplaceRules: MatchReplaceRule[] = [];
    let cachedMessageDebugSettings: MessageDebugSettings = {
      consoleLogEnabled: false,
      debugBreakEnabled: false,
      debugBreakMatch: '',
      maxCapturedMessageSize: 0
    };

    function normalizeMessageDebugSettingsInput(
      value: Partial<MessageDebugSettings> | null | undefined
    ): MessageDebugSettings {
      const maxSize = value && typeof value.maxCapturedMessageSize === 'number' && Number.isFinite(value.maxCapturedMessageSize)
        ? Math.max(0, Math.floor(value.maxCapturedMessageSize))
        : 0;
      return {
        consoleLogEnabled: !!value?.consoleLogEnabled,
        debugBreakEnabled: !!value?.debugBreakEnabled,
        debugBreakMatch:
          value && typeof value.debugBreakMatch === 'string' ? value.debugBreakMatch : '',
        maxCapturedMessageSize: maxSize
      };
    }

    // Send an envelope to the MAIN world via a document CustomEvent.
    // Detail is a JSON string - primitives are world-safe across worlds.
    function sendToMain(type: string, detail?: unknown): void {
      try {
        document.dispatchEvent(
          new CustomEvent(TRACKER_EVENT_TO_MAIN, {
            detail: JSON.stringify({ type, detail })
          })
        );
      } catch {
        // Ignore
      }
    }

    function forwardBlacklist(): void {
      sendToMain(BLACKLIST_TYPE, { blacklist: EXTENSION_BLACKLIST });
    }

    function forwardActiveState(): void {
      sendToMain(ACTIVE_TYPE, { active: bridgeActive });
    }

    function forwardMatchReplaceRules(rules: MatchReplaceRule[] | null | undefined): void {
      cachedMatchReplaceRules = Array.isArray(rules) ? rules : [];
      if (!bridgeActive) return;

      sendToMain(RULES_TYPE, { rules: cachedMatchReplaceRules });
    }

    function forwardMessageDebugSettings(
      settings: Partial<MessageDebugSettings> | null | undefined
    ): void {
      cachedMessageDebugSettings = normalizeMessageDebugSettingsInput(settings);
      if (!bridgeActive) return;

      sendToMain(SETTINGS_TYPE, cachedMessageDebugSettings);
    }

    function sendMessageSafely(message: unknown): void {
      if (!bridgeActive) return;
      if (!chrome.runtime || !chrome.runtime.id) return;

      try {
        chrome.runtime.sendMessage(message, () => {
          if (chrome.runtime.lastError) {
            console.error(
              'Fransyfox: Bridge runtime error:',
              chrome.runtime.lastError.message
            );
          }
        });
      } catch (error) {
        console.error('Fransyfox: Bridge exception:', error);
      }
    }

    // Listener records are retried with a response watchdog. A cold-started
    // background (event page or service worker) can drop early sends without
    // ever invoking the callback; the background dedupes by listener key, so
    // resends are idempotent. Message events stay lossy by design.
    const LISTENER_RETRY_MAX = 3;
    const LISTENER_RESPONSE_TIMEOUT_MS = 1200;
    const LISTENER_RETRY_DELAY_MS = 300;

    function sendListenerDataReliably(detail: unknown): void {
      if (!bridgeActive) return;
      if (!chrome.runtime || !chrome.runtime.id) return;

      let settled = false;
      let attempts = 0;

      const attempt = (): void => {
        if (settled || attempts >= LISTENER_RETRY_MAX) return;
        attempts += 1;

        let responsive = false;
        try {
          chrome.runtime.sendMessage(detail, () => {
            responsive = true;
            const error = chrome.runtime.lastError;
            if (error) {
              console.error(
                'Fransyfox: Listener send failed:',
                error.message
              );
              scheduleRetry();
            } else {
              settled = true;
            }
          });
        } catch (error) {
          console.error('Fransyfox: Listener send exception:', error);
          scheduleRetry();
        }

        setTimeout(() => {
          if (!settled && !responsive) {
            scheduleRetry();
          }
        }, LISTENER_RESPONSE_TIMEOUT_MS);
      };

      const scheduleRetry = (): void => {
        if (settled || attempts >= LISTENER_RETRY_MAX) return;
        setTimeout(attempt, LISTENER_RETRY_DELAY_MS);
      };

      attempt();
    }

    // --- Message-event batching -------------------------------------------
    // Captured postMessage events are queued and flushed in batches instead
    // of one chrome.runtime.sendMessage per event. With flood protection on,
    // the queue is hard-capped and overflow is counted, never silently lost.
    const EVENT_FLUSH_INTERVAL_MS = 100;
    const EVENT_FLUSH_MAX_BATCH = 50;
    const EVENT_QUEUE_HARD_CAP = 500;
    let floodProtectionEnabled = true;
    const eventBatcher = createTimedEventBatcher<Record<string, unknown>>({
      flushIntervalMs: EVENT_FLUSH_INTERVAL_MS,
      maxBatchSize: EVENT_FLUSH_MAX_BATCH,
      hardCap: EVENT_QUEUE_HARD_CAP,
      onBatch: ({ events, dropped }) => {
        const message: Record<string, unknown> = { eventType: 'postMessageBatch', events };
        if (dropped > 0) {
          message.dropped = dropped;
        }
        sendMessageSafely(message);
      }
    });

    function enqueueTrackedEvent(detail: unknown): void {
      if (!bridgeActive) return;
      const record = typeof detail === 'object' && detail !== null
        ? Object.assign({}, detail as Record<string, unknown>)
        : { dataText: String(detail ?? '') };
      // Stamp capture time at enqueue so batching does not skew timestamps
      record.capturedAt = Date.now();
      eventBatcher.enqueue(record, floodProtectionEnabled);
    }

    function discardEventQueue(): void {
      eventBatcher.discard();
    }

    function requestTrackerSettings(): void {
      if (!bridgeActive) return;

      try {
        chrome.runtime.sendMessage(
          { action: 'requestMatchReplaceRules' },
          (response: { rules?: MatchReplaceRule[] } | undefined) => {
            if (response && response.rules) {
              forwardMatchReplaceRules(response.rules);
            }
          }
        );

        chrome.runtime.sendMessage(
          { action: 'requestMessageDebugSettings' },
          (response: { settings?: MessageDebugSettings } | undefined) => {
            if (response && response.settings) {
              forwardMessageDebugSettings(response.settings);
            }
          }
        );
      } catch {
        // Ignore
      }
    }

    function onBeforeUnload(): void {
      // Flush queued events before the navigation marker so end-of-page
      // events are delivered and ordering vs. changePage is preserved.
      eventBatcher.flushAll();
      sendMessageSafely({ changePage: true });
    }

    function onPageHide(): void {
      // beforeunload does not fire for bfcache navigations
      eventBatcher.flushAll();
    }

    function getTrackerMessage(event: Event): ReturnType<typeof parseBridgeWindowMessage> {
      const detailRaw = (event as CustomEvent).detail;
      if (typeof detailRaw !== 'string') return null;
      let parsed: unknown;
      try {
        parsed = JSON.parse(detailRaw);
      } catch {
        return null;
      }
      return parseBridgeWindowMessage(parsed);
    }

    function onTrackingMessage(event: Event): void {
      const message = getTrackerMessage(event);
      if (!message) return;

      if (message.type === 'FRANSYFOX_DATA') {
        sendListenerDataReliably(message.detail);
        return;
      }

      if (message.type === 'FRANSYFOX_EVENT') {
        enqueueTrackedEvent(message.detail);
        return;
      }

      if (message.type === RULES_REQUEST_TYPE) {
        forwardMatchReplaceRules(cachedMatchReplaceRules);
        return;
      }

      if (message.type === SETTINGS_REQUEST_TYPE) {
        forwardMessageDebugSettings(cachedMessageDebugSettings);
        return;
      }

      if (message.type === 'FRANSYFOX_BLACKLIST_REQUEST') {
        forwardBlacklist();
      }
    }

    function onControlMessage(event: Event): void {
      const message = getTrackerMessage(event);
      if (!message) return;

      if (message.type === ACTIVE_REQUEST_TYPE) {
        forwardActiveState();
      }
    }

    function attachTrackingListeners(): void {
      if (trackingListenersAttached) return;
      document.addEventListener(TRACKER_EVENT_TO_BRIDGE, onTrackingMessage);
      window.addEventListener('beforeunload', onBeforeUnload);
      window.addEventListener('pagehide', onPageHide);
      trackingListenersAttached = true;
    }

    function detachTrackingListeners(): void {
      if (!trackingListenersAttached) return;
      document.removeEventListener(TRACKER_EVENT_TO_BRIDGE, onTrackingMessage);
      window.removeEventListener('beforeunload', onBeforeUnload);
      window.removeEventListener('pagehide', onPageHide);
      // Tracking is being disabled - queued events are intentionally dropped
      discardEventQueue();
      trackingListenersAttached = false;
    }

    function setBridgeActive(active: boolean): void {
      const normalized = active !== false;
      const changed = bridgeActive !== normalized;
      bridgeActive = normalized;

      if (bridgeActive) {
        attachTrackingListeners();
        forwardBlacklist();
        forwardMatchReplaceRules(cachedMatchReplaceRules);
        forwardMessageDebugSettings(cachedMessageDebugSettings);
        if (changed) {
          requestTrackerSettings();
        }
      } else {
        detachTrackingListeners();
      }

      forwardActiveState();
    }

    chrome.runtime.onMessage.addListener((message: unknown) => {
      const msg = asRecord(message);
      if (!msg) return;

      if (msg.action === 'extensionActiveUpdated') {
        setBridgeActive(msg.active !== false);
        return;
      }

      if (msg.action === 'matchReplaceRulesUpdated') {
        const rules = Array.isArray(msg.rules)
          ? (msg.rules as MatchReplaceRule[])
          : [];
        cachedMatchReplaceRules = rules;
        if (bridgeActive) {
          forwardMatchReplaceRules(cachedMatchReplaceRules);
        }
        return;
      }

      if (msg.action === 'messageDebugSettingsUpdated') {
        const settings = asRecord(msg.settings) as Partial<MessageDebugSettings> | null;
        cachedMessageDebugSettings = normalizeMessageDebugSettingsInput(settings || undefined);
        if (bridgeActive) {
          forwardMessageDebugSettings(cachedMessageDebugSettings);
        }
        return;
      }

      // Composer: deliver a panel-crafted postMessage in this frame's MAIN world.
      if (msg.action === 'composeSend') {
        sendToMain('FRANSYFOX_SEND', msg.detail);
      }
    });

    document.addEventListener(TRACKER_EVENT_TO_BRIDGE, onControlMessage);
    attachTrackingListeners();

    chrome.storage.local.get(
      { [EXTENSION_ACTIVE_KEY]: true, [FLOOD_PROTECTION_KEY]: true },
      (result: Record<string, unknown>) => {
        floodProtectionEnabled = result[FLOOD_PROTECTION_KEY] !== false;
        setBridgeActive(result[EXTENSION_ACTIVE_KEY] !== false);
        requestTrackerSettings();
      }
    );

    chrome.storage.onChanged.addListener((changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area !== 'local') return;
      if (changes[FLOOD_PROTECTION_KEY]) {
        floodProtectionEnabled = changes[FLOOD_PROTECTION_KEY].newValue !== false;
      }
    });

    console.log('Fransyfox: Bridge initialized');
  })();
}
