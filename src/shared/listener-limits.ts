import type { ListenerRecord } from '../types/listener';

export const MAX_LISTENER_SOURCE_CHARS = 8 * 1024;
export const MAX_LISTENER_STACK_CHARS = 2 * 1024;
export const MAX_LISTENER_FULLSTACK_LINES = 20;
export const MAX_LISTENER_FULLSTACK_LINE_CHARS = 512;
export const MAX_LISTENER_URL_CHARS = 4 * 1024;
export const MAX_LISTENERS_PER_TAB = 500;
export const MAX_LISTENERS_TOTAL = 1000;

const MAX_HASH_PREFIX_CHARS = 64 * 1024;
const MAX_HASH_SUFFIX_CHARS = 4 * 1024;
const ALLOWED_LISTENER_KEYS = new Set([
  'window', 'hops', 'domain', 'parent_url', 'stack', 'fullstack', 'listener',
  'listenerCaptureHash', 'listenerLength', 'listenerTruncated', 'capturedAt',
  'jsurl', 'blocked', 'stale', 'frameId', 'frameUrl', 'findings',
  'findingsVersion', 'listenerKey'
]);

function fnv1aUpdate(hash: number, value: string): number {
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Produces a compact, stable identity without scanning an attacker-sized
 * function body in full. The original length and tail distinguish sources
 * that share a long generated prefix.
 */
export function hashListenerSource(source: string): string {
  let hash = 0x811c9dc5;
  hash = fnv1aUpdate(hash, source.slice(0, MAX_HASH_PREFIX_CHARS));
  if (source.length > MAX_HASH_PREFIX_CHARS) {
    hash = fnv1aUpdate(hash, source.slice(-MAX_HASH_SUFFIX_CHARS));
  }
  hash = fnv1aUpdate(hash, `:${source.length}`);
  return hash.toString(16).padStart(8, '0');
}

export interface CapturedListenerSource {
  text: string;
  hash: string;
  length: number;
  truncated: boolean;
}

export function captureListenerSource(source: string): CapturedListenerSource {
  return {
    text: source.slice(0, MAX_LISTENER_SOURCE_CHARS),
    hash: hashListenerSource(source),
    length: source.length,
    truncated: source.length > MAX_LISTENER_SOURCE_CHARS
  };
}

function capString(value: unknown, maxChars: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  return value.slice(0, maxChars);
}

export function capListenerFullStack(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value
    .slice(0, MAX_LISTENER_FULLSTACK_LINES)
    .map((line) => capString(line, MAX_LISTENER_FULLSTACK_LINE_CHARS) || '');
}

function setCappedString(
  listener: ListenerRecord,
  key: keyof ListenerRecord,
  maxChars: number
): boolean {
  const value = listener[key];
  if (value === undefined || (key === 'jsurl' && value === null)) return false;
  if (typeof value !== 'string') {
    delete listener[key];
    return true;
  }
  if (value.length <= maxChars) return false;
  listener[key] = value.slice(0, maxChars);
  return true;
}

/** Mutates a listener into its bounded persisted/transport-safe shape. */
export function sanitizeListenerRecord(listener: ListenerRecord, capturedAt = Date.now()): boolean {
  let changed = false;
  for (const key of Object.keys(listener)) {
    if (!ALLOWED_LISTENER_KEYS.has(key)) {
      delete listener[key];
      changed = true;
    }
  }
  const source = typeof listener.listener === 'string' ? listener.listener : String(listener.listener ?? '');
  const suppliedLength = typeof listener.listenerLength === 'number'
    && Number.isFinite(listener.listenerLength)
    && listener.listenerLength >= source.length
    ? Math.floor(listener.listenerLength)
    : source.length;
  const suppliedHash = typeof listener.listenerCaptureHash === 'string'
    && /^[0-9a-f]{8}$/i.test(listener.listenerCaptureHash)
    ? listener.listenerCaptureHash.toLowerCase()
    : null;
  const captured = captureListenerSource(source);
  const boundedSource = captured.text;

  if (listener.listener !== boundedSource) {
    listener.listener = boundedSource;
    changed = true;
  }
  const sourceHash = suppliedHash || captured.hash;
  if (listener.listenerCaptureHash !== sourceHash) {
    listener.listenerCaptureHash = sourceHash;
    changed = true;
  }
  if (listener.listenerLength !== suppliedLength) {
    listener.listenerLength = suppliedLength;
    changed = true;
  }
  const truncated = suppliedLength > boundedSource.length;
  if (listener.listenerTruncated !== truncated) {
    listener.listenerTruncated = truncated;
    changed = true;
  }
  if (typeof listener.capturedAt !== 'number' || !Number.isFinite(listener.capturedAt)) {
    listener.capturedAt = capturedAt;
    changed = true;
  }

  changed = setCappedString(listener, 'stack', MAX_LISTENER_STACK_CHARS) || changed;
  changed = setCappedString(listener, 'parent_url', MAX_LISTENER_URL_CHARS) || changed;
  changed = setCappedString(listener, 'frameUrl', MAX_LISTENER_URL_CHARS) || changed;
  changed = setCappedString(listener, 'jsurl', MAX_LISTENER_URL_CHARS) || changed;
  changed = setCappedString(listener, 'hops', MAX_LISTENER_STACK_CHARS) || changed;
  changed = setCappedString(listener, 'domain', MAX_LISTENER_STACK_CHARS) || changed;
  changed = setCappedString(listener, 'window', MAX_LISTENER_STACK_CHARS) || changed;

  if (Array.isArray(listener.fullstack)) {
    const capped = capListenerFullStack(listener.fullstack) || [];
    if (listener.fullstack.length !== capped.length
      || listener.fullstack.some((line, index) => line !== capped[index])) {
      listener.fullstack = capped;
      changed = true;
    }
  }
  else if (listener.fullstack !== undefined) {
    delete listener.fullstack;
    changed = true;
  }

  // The source or stack may have changed, so callers must recompute the key.
  if (changed && listener.listenerKey) {
    delete listener.listenerKey;
  }
  return changed;
}

export function getListenerSourceIdentity(listener: ListenerRecord): string {
  const hash = typeof listener.listenerCaptureHash === 'string'
    ? listener.listenerCaptureHash
    : hashListenerSource(listener.listener || '');
  const length = typeof listener.listenerLength === 'number'
    ? listener.listenerLength
    : (listener.listener || '').length;
  return `${hash}:${length}`;
}

/** Prefer stale history, then evict the oldest record. */
export function selectListenerEvictionIndex(listeners: ListenerRecord[]): number {
  if (listeners.length === 0) return -1;
  let selected = -1;
  let selectedTimestamp = Number.POSITIVE_INFINITY;
  const hasStale = listeners.some((listener) => listener.stale === true);
  for (let i = 0; i < listeners.length; i++) {
    const listener = listeners[i];
    if (hasStale && listener.stale !== true) continue;
    const timestamp = typeof listener.capturedAt === 'number' && Number.isFinite(listener.capturedAt)
      ? listener.capturedAt
      : 0;
    if (timestamp < selectedTimestamp) {
      selected = i;
      selectedTimestamp = timestamp;
    }
  }
  return selected;
}

export function compareListenerEvictionPriority(left: ListenerRecord, right: ListenerRecord): number {
  if (left.stale === true && right.stale !== true) return -1;
  if (left.stale !== true && right.stale === true) return 1;
  const leftTimestamp = typeof left.capturedAt === 'number' && Number.isFinite(left.capturedAt)
    ? left.capturedAt
    : 0;
  const rightTimestamp = typeof right.capturedAt === 'number' && Number.isFinite(right.capturedAt)
    ? right.capturedAt
    : 0;
  return leftTimestamp - rightTimestamp;
}
