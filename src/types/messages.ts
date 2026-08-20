import type { ListenerRecord, MessageEventRecord, FrameNode } from './listener';
import type { MessageDebugSettings, MatchReplaceRule } from './settings';

export type RuntimeRequestMessage =
  | { action: 'requestExtensionActive' }
  | { action: 'updateExtensionActive'; enabled: boolean }
  | { action: 'requestMatchReplaceRules' }
  | { action: 'requestMessageDebugSettings' }
  | { action: 'updateDedupeSetting'; enabled: boolean }
  | { action: 'requestPreserveLog' }
  | { action: 'updatePreserveLog'; enabled: boolean }
  | { action: 'clearFindings'; tabId: number }
  | { action: 'openInDevtools'; url: string; line: number; column: number; tabId: number }
  | {
      action: 'sendPostMessage';
      tabId: number;
      frameId: number;
      target: 'self' | 'top' | 'parent' | 'opener';
      payload: string;
      payloadType: 'string' | 'json';
      targetOrigin: string;
    }
  | { action: 'listenerData'; listener: ListenerRecord }
  | ListenerRecord
  | { eventType: 'postMessage'; event: MessageEventRecord }
  | { eventType: 'postMessageBatch'; events: MessageEventRecord[]; dropped?: number }
  | { changePage: true }
  | { pushState: true }
  | { log: string };

export type RuntimeResponseMessage =
  | { success: true; active?: boolean; inactive?: boolean }
  | { success: true; rules?: MatchReplaceRule[] }
  | { success: true; settings?: MessageDebugSettings }
  | { success: false; error?: string }
  | { active: boolean }
  | { rules: MatchReplaceRule[] }
  | { settings: MessageDebugSettings };

export type EventsClearedReason = 'navigation' | 'manual' | 'eviction';

export type PortRequestMessage =
  | { type: 'REQUEST_STATE'; tabId?: number | null }
  | { type: 'REQUEST_EVENTS' }
  | { type: 'REQUEST_FRAME_TREE'; tabId?: number | null }
  | { type: 'CLEAR_EVENTS'; tabId?: number | null }
  | { type: 'CLEAR_LISTENERS'; tabId?: number | null };

export type PortResponseMessage =
  | {
      type: 'STATE';
      tabId: number | null;
      listeners: ListenerRecord[];
      currentUrl?: string;
      extensionActive: boolean;
      cached: boolean;
      timestamp: number;
      dataVersion: number;
    }
  | {
      type: 'EVENTS';
      events: MessageEventRecord[];
      timestamp: number;
      version: number;
      maxEvents: number;
      restored?: boolean;
    }
  | {
      type: 'EVENTS_APPEND';
      events: MessageEventRecord[];
      timestamp: number;
      fromVersion: number;
      version: number;
      maxEvents: number;
      /** Number of oldest retained events removed while applying this append. */
      evictedCount?: number;
      /** Cumulative flood-protection drop counts per tabId. */
      droppedByTab?: Record<string, number>;
    }
  | {
      type: 'EVENTS_CLEARED';
      timestamp: number;
      reason: EventsClearedReason;
      tabId?: number | null;
      version: number;
    }
  | { type: 'LISTENERS_CLEARED'; timestamp: number }
  | {
      type: 'FRAME_TREE';
      tabId: number | null;
      frames: FrameNode[];
      version: number;
      timestamp: number;
    };

export type BridgeWindowMessage =
  | { type: 'FRANSYFOX_DATA'; detail: ListenerRecord }
  | { type: 'FRANSYFOX_EVENT'; detail: MessageEventRecord }
  | { type: 'FRANSYFOX_RULES'; detail: { rules: MatchReplaceRule[] } }
  | { type: 'FRANSYFOX_SETTINGS'; detail: MessageDebugSettings }
  | { type: 'FRANSYFOX_ACTIVE'; detail: { active: boolean } }
  | { type: 'FRANSYFOX_BLACKLIST'; detail: { blacklist: string[] } }
  | {
      type: 'FRANSYFOX_SEND';
      detail: {
        target: 'self' | 'top' | 'parent' | 'opener';
        payload: string;
        payloadType: 'string' | 'json';
        targetOrigin: string;
      };
    };
