import type { ListenerRecord } from '../types/listener';
import type { MatchReplaceRule, MessageDebugSettings } from '../types/settings';
import { HARD_CAPTURE_LIMIT_CHARS } from '../shared/capture-serializer';
import { MAX_USER_REGEX_RULES, compileSafeRegex } from '../shared/safe-regex';

export type MessageSortOrder = 'asc' | 'desc';
export type PanelViewMode = 'listeners' | 'messages' | 'findings' | 'match' | 'map' | 'timeline';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function normalizeBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

export function normalizeString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

export function normalizeMessageFilterText(value: unknown, fallback = ''): string {
  return normalizeString(value, fallback);
}

export function normalizeMessageSortOrder(
  value: unknown,
  fallback: MessageSortOrder = 'desc'
): MessageSortOrder {
  return value === 'asc' || value === 'desc' ? value : fallback;
}

export function normalizePanelViewMode(
  value: unknown,
  fallback: PanelViewMode = 'listeners'
): PanelViewMode {
  return value === 'listeners' || value === 'messages' || value === 'findings' || value === 'match' || value === 'map' || value === 'timeline'
    ? value
    : fallback;
}

export function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string');
}

export function normalizeMatchReplaceRules(value: unknown): MatchReplaceRule[] {
  if (!Array.isArray(value)) return [];
  const rules: MatchReplaceRule[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    if (typeof item.pattern !== 'string') continue;
    if (typeof item.replacement !== 'string') continue;
    if (!compileSafeRegex(item.pattern, 'g').regex) continue;
    rules.push({ pattern: item.pattern, replacement: item.replacement });
    if (rules.length >= MAX_USER_REGEX_RULES) break;
  }
  return rules;
}

export function normalizeNonNegativeInt(value: unknown, fallback = 0): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return fallback;
  }
  return Math.floor(value);
}

export function normalizeMessageDebugSettings(value: unknown): MessageDebugSettings {
  if (!isRecord(value)) {
    return { consoleLogEnabled: false, debugBreakEnabled: false, debugBreakMatch: '', maxCapturedMessageSize: 0 };
  }

  const debugBreakMatch = normalizeString(value.debugBreakMatch, '');
  return {
    consoleLogEnabled: normalizeBoolean(value.consoleLogEnabled, false),
    debugBreakEnabled: normalizeBoolean(value.debugBreakEnabled, false),
    debugBreakMatch: debugBreakMatch && compileSafeRegex(debugBreakMatch, 'i').regex
      ? debugBreakMatch
      : '',
    maxCapturedMessageSize: Math.min(
      normalizeNonNegativeInt(value.maxCapturedMessageSize, 0),
      HARD_CAPTURE_LIMIT_CHARS
    )
  };
}

export function normalizeListenerRecord(value: unknown): ListenerRecord | null {
  if (!isRecord(value)) return null;
  if (typeof value.listener !== 'string') return null;
  return value as ListenerRecord;
}
