import type {
  BridgeWindowMessage,
  PortResponseMessage,
  PortRequestMessage,
  RuntimeRequestMessage
} from '../types/messages';

const RUNTIME_ACTIONS = new Set([
  'requestExtensionActive',
  'updateExtensionActive',
  'requestMatchReplaceRules',
  'requestMessageDebugSettings',
  'updateDedupeSetting',
  'clearFindings',
  'openInDevtools',
  'listenerData',
  'requestPreserveLog',
  'updatePreserveLog',
  'sendPostMessage'
] as const);

const PORT_TYPES = new Set(['REQUEST_STATE', 'REQUEST_EVENTS', 'REQUEST_FRAME_TREE', 'CLEAR_EVENTS', 'CLEAR_LISTENERS'] as const);
const PORT_RESPONSE_TYPES = new Set([
  'STATE',
  'EVENTS',
  'EVENTS_APPEND',
  'EVENTS_CLEARED',
  'LISTENERS_CLEARED',
  'FRAME_TREE'
] as const);

const BRIDGE_MESSAGE_TYPES = new Set([
  'FRANSYFOX_DATA',
  'FRANSYFOX_EVENT',
  'FRANSYFOX_RULES',
  'FRANSYFOX_SETTINGS',
  'FRANSYFOX_ACTIVE',
  'FRANSYFOX_BLACKLIST',
  'FRANSYFOX_RULES_REQUEST',
  'FRANSYFOX_SETTINGS_REQUEST',
  'FRANSYFOX_ACTIVE_REQUEST',
  'FRANSYFOX_BLACKLIST_REQUEST',
  'FRANSYFOX_SEND'
] as const);

// DOM CustomEvent names carrying tracker envelopes between the MAIN and
// ISOLATED worlds. Unlike window.postMessage envelopes, these are invisible
// to page 'message' listeners (and to our own postMessage hooks), so tracker
// traffic does not amplify page message dispatch. The CustomEvent detail is
// always a JSON string - primitives are world-safe across isolated worlds.
export const TRACKER_EVENT_TO_BRIDGE = 'fransyfox:to-bridge';
export const TRACKER_EVENT_TO_MAIN = 'fransyfox:to-main';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function parseRuntimeRequestMessage(value: unknown): RuntimeRequestMessage | null {
  if (!isRecord(value)) return null;

  if (typeof value.action === 'string' && RUNTIME_ACTIONS.has(value.action as (typeof RUNTIME_ACTIONS extends Set<infer U> ? U : never))) {
    return value as RuntimeRequestMessage;
  }

  if (value.eventType === 'postMessage' && 'event' in value) {
    return value as RuntimeRequestMessage;
  }

  if (value.eventType === 'postMessageBatch' && Array.isArray(value.events)) {
    return value as RuntimeRequestMessage;
  }

  if (value.changePage === true || value.pushState === true) {
    return value as RuntimeRequestMessage;
  }

  if (typeof value.log === 'string') {
    return value as RuntimeRequestMessage;
  }

  // Listener payloads from main-world hook are sent as direct records
  // (not wrapped in an action field).
  if (typeof value.listener === 'string') {
    return value as RuntimeRequestMessage;
  }

  return null;
}

export function parsePortRequestMessage(value: unknown): PortRequestMessage | null {
  if (!isRecord(value)) return null;
  if (typeof value.type !== 'string') return null;
  if (!PORT_TYPES.has(value.type as (typeof PORT_TYPES extends Set<infer U> ? U : never))) return null;
  if ('tabId' in value && value.tabId !== undefined && value.tabId !== null
    && (typeof value.tabId !== 'number' || !Number.isSafeInteger(value.tabId) || value.tabId < 0)) {
    return null;
  }
  return value as PortRequestMessage;
}

export function parsePortResponseMessage(value: unknown): PortResponseMessage | null {
  if (!isRecord(value)) return null;
  if (typeof value.type === 'string' && PORT_RESPONSE_TYPES.has(value.type as (typeof PORT_RESPONSE_TYPES extends Set<infer U> ? U : never))) {
    return value as PortResponseMessage;
  }

  // Backwards-compatible state shape without explicit type
  if (!('type' in value) && ('listeners' in value || 'currentUrl' in value)) {
    return Object.assign({ type: 'STATE' }, value) as PortResponseMessage;
  }

  return null;
}

export type TrackerBridgeMessage = BridgeWindowMessage | { type: string; detail?: unknown };

export function parseBridgeWindowMessage(value: unknown): TrackerBridgeMessage | null {
  if (!isRecord(value)) return null;
  if (typeof value.type !== 'string') return null;
  if (!BRIDGE_MESSAGE_TYPES.has(value.type as (typeof BRIDGE_MESSAGE_TYPES extends Set<infer U> ? U : never))) return null;
  return value as TrackerBridgeMessage;
}

export function isRuntimeAction(
  message: RuntimeRequestMessage | null,
  action: string
): boolean {
  return !!message && 'action' in message && message.action === action;
}
