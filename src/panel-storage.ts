import {
  normalizeBoolean,
  normalizeMessageFilterText,
  normalizeMessageSortOrder,
  normalizePanelViewMode,
  normalizeMatchReplaceRules,
  normalizeMessageDebugSettings,
  normalizeString,
  normalizeStringArray
} from './contracts/state';
import { MAX_USER_REGEX_RULES, compileSafeRegex, limitRegexInput } from './shared/safe-regex';
import type { ListenerRecord } from './types/listener';
import type { MatchReplaceRule, MessageDebugSettings } from './types/settings';

// Storage and blocklist management for Fransceiver
const { STORAGE_KEYS } = FransceiverConstants;
const { cleanUrl, extractJsUrlFromStack } = FransceiverUrlUtils;
const storageLog = FransceiverLogger.scoped('panel-storage');

type HighlightRules = Record<string, string[]>;
type BlockType = 'listener' | 'url' | 'regex';

interface BlockMatch {
  type: BlockType;
  value: string;
}

interface CompiledRegexRule {
  pattern: string;
  regex: RegExp;
}

type ImportDataCallback = (err: Error | null, data?: Record<string, unknown>) => void;
type ImportResultCallback = (err: Error | null, message?: string) => void;
type MessageSortOrder = 'asc' | 'desc';
type PanelViewMode = 'listeners' | 'messages' | 'findings' | 'match' | 'map' | 'timeline';

interface MessageViewSettings {
  query: string;
  targetFrame: string;
  sortOrder: MessageSortOrder;
  allExpanded: boolean;
}

class PanelStorage {
  highlightRules: HighlightRules;
  blockedListeners: string[];
  blockedUrls: string[];
  blockedRegex: string[];
  matchReplaceRules: MatchReplaceRule[];
  matchReplaceRulesText: string;
  compiledRegex: CompiledRegexRule[];
  originalLogUrl: string;
  prettifyEnabled: boolean;
  dedupeEnabled: boolean;
  syntaxHighlightEnabled: boolean;
  messageBeautifyEnabled: boolean;
  messageQuery: string;
  messageTargetFrame: string;
  messageSortOrder: MessageSortOrder;
  messageAllExpanded: boolean;
  panelViewMode: PanelViewMode;
  messageConsoleLogEnabled: boolean;
  messageDebugBreakEnabled: boolean;
  messageDebugBreakMatch: string;
  messageMaxCaptureSize: number;
  floodProtectionEnabled: boolean;
  grepExtractRegex: string;
  expandThreshold: number;
  maxLines: number;
  codeFontSize: number;
  // Memoized isListenerBlocked results, keyed by listenerKey. Invalidated
  // whenever the blocklists or regex patterns change.
  private blockMemo: Map<string, BlockMatch | null>;

  constructor() {
    this.highlightRules = {};
    this.blockMemo = new Map<string, BlockMatch | null>();
    this.blockedListeners = [];
    this.blockedUrls = [];
    this.blockedRegex = [];
    this.matchReplaceRules = [];
    this.matchReplaceRulesText = '';
    this.compiledRegex = []; // Compiled regex patterns for performance
    this.originalLogUrl = '';
    this.prettifyEnabled = false;
    this.dedupeEnabled = true; // Default: enabled
    this.syntaxHighlightEnabled = true; // Default to true
    this.messageBeautifyEnabled = false; // Default: raw messages
    this.messageQuery = '';
    this.messageTargetFrame = 'any';
    this.messageSortOrder = 'desc';
    this.messageAllExpanded = false;
    this.panelViewMode = 'listeners';
    this.messageConsoleLogEnabled = false;
    this.messageDebugBreakEnabled = false;
    this.messageDebugBreakMatch = '';
    this.messageMaxCaptureSize = 0; // 0 = automatic 64K capture limit
    this.floodProtectionEnabled = true;
    this.grepExtractRegex = 'https?://[^\\s"\'<>)]+';
    this.expandThreshold = 4000;
    this.maxLines = 40;
    this.codeFontSize = 12;
  }

  // Initialize storage
  async init(): Promise<void> {
    await this.loadHighlightRules();
    await this.loadBlocklists();
    await this.loadLogUrl();
    await this.loadPrettifySetting();
    await this.loadDedupeSetting();
    await this.loadSyntaxHighlightSetting();
    await this.loadMessageBeautifySetting();
    await this.loadMessageViewSettings();
    await this.loadPanelViewMode();
    await this.loadMessageDebugSettings();
    await this.loadCodeSettings();
    await this.loadRegexPatterns();
    await this.loadMatchReplaceRules();
    await this.loadGrepExtractRegex();
  }

  // Load syntax highlighting setting
  loadSyntaxHighlightSetting(): Promise<void> {
    return new Promise((resolve) => {
      chrome.storage.local.get(['syntaxHighlightEnabled'], (result: Record<string, unknown>) => {
        this.syntaxHighlightEnabled = normalizeBoolean(result.syntaxHighlightEnabled, true);
        storageLog.info(
          'Fransceiver: Loaded syntax highlight setting:',
          this.syntaxHighlightEnabled
        );
        resolve();
      });
    });
  }

  // Save syntax highlighting setting
  saveSyntaxHighlightSetting(enabled: boolean): Promise<void> {
    return new Promise((resolve) => {
      this.syntaxHighlightEnabled = enabled;
      chrome.storage.local.set({ syntaxHighlightEnabled: enabled }, () => {
        storageLog.info('Fransceiver: Saved syntax highlight setting:', enabled);
        resolve();
      });
    });
  }

  // Load message beautify setting
  loadMessageBeautifySetting(): Promise<void> {
    return new Promise((resolve) => {
      chrome.storage.local.get(
        [STORAGE_KEYS.MESSAGE_BEAUTIFY_ENABLED],
        (result: Record<string, unknown>) => {
          this.messageBeautifyEnabled = normalizeBoolean(
            result[STORAGE_KEYS.MESSAGE_BEAUTIFY_ENABLED],
            false
          );
          resolve();
        }
      );
    });
  }

  // Save message beautify setting
  saveMessageBeautifySetting(enabled: boolean): Promise<void> {
    return new Promise((resolve) => {
      this.messageBeautifyEnabled = enabled;
      chrome.storage.local.set({ [STORAGE_KEYS.MESSAGE_BEAUTIFY_ENABLED]: enabled }, () => {
        resolve();
      });
    });
  }

  loadMessageViewSettings(): Promise<void> {
    return new Promise((resolve) => {
      chrome.storage.local.get(
        [
          STORAGE_KEYS.MESSAGE_QUERY,
          STORAGE_KEYS.MESSAGE_TARGET_FRAME,
          STORAGE_KEYS.MESSAGE_SORT_ORDER,
          STORAGE_KEYS.MESSAGE_ALL_EXPANDED
        ],
        (result: Record<string, unknown>) => {
          this.messageQuery = normalizeMessageFilterText(result[STORAGE_KEYS.MESSAGE_QUERY], '');
          const targetFrame = normalizeMessageFilterText(
            result[STORAGE_KEYS.MESSAGE_TARGET_FRAME],
            'any'
          ).trim();
          this.messageTargetFrame = targetFrame || 'any';
          this.messageSortOrder = normalizeMessageSortOrder(
            result[STORAGE_KEYS.MESSAGE_SORT_ORDER],
            'desc'
          );
          this.messageAllExpanded = normalizeBoolean(
            result[STORAGE_KEYS.MESSAGE_ALL_EXPANDED],
            false
          );
          resolve();
        }
      );
    });
  }

  saveMessageViewSettings(settings: Partial<MessageViewSettings>): Promise<void> {
    const query = normalizeMessageFilterText(settings.query, this.messageQuery);
    const targetFrame =
      normalizeMessageFilterText(settings.targetFrame, this.messageTargetFrame).trim() || 'any';
    const sortOrder = normalizeMessageSortOrder(settings.sortOrder, this.messageSortOrder);
    const allExpanded = normalizeBoolean(settings.allExpanded, this.messageAllExpanded);
    this.messageQuery = query;
    this.messageTargetFrame = targetFrame;
    this.messageSortOrder = sortOrder;
    this.messageAllExpanded = allExpanded;

    return new Promise((resolve) => {
      chrome.storage.local.set(
        {
          [STORAGE_KEYS.MESSAGE_QUERY]: this.messageQuery,
          [STORAGE_KEYS.MESSAGE_TARGET_FRAME]: this.messageTargetFrame,
          [STORAGE_KEYS.MESSAGE_SORT_ORDER]: this.messageSortOrder,
          [STORAGE_KEYS.MESSAGE_ALL_EXPANDED]: this.messageAllExpanded
        },
        () => {
          resolve();
        }
      );
    });
  }

  loadPanelViewMode(): Promise<void> {
    return new Promise((resolve) => {
      chrome.storage.local.get([STORAGE_KEYS.PANEL_VIEW_MODE], (result: Record<string, unknown>) => {
        this.panelViewMode = normalizePanelViewMode(result[STORAGE_KEYS.PANEL_VIEW_MODE], 'listeners');
        resolve();
      });
    });
  }

  savePanelViewMode(mode: PanelViewMode): Promise<void> {
    this.panelViewMode = normalizePanelViewMode(mode, 'listeners');
    return new Promise((resolve) => {
      chrome.storage.local.set({ [STORAGE_KEYS.PANEL_VIEW_MODE]: this.panelViewMode }, () => {
        resolve();
      });
    });
  }

  loadMessageDebugSettings(): Promise<void> {
    return new Promise((resolve) => {
      chrome.storage.local.get(
        [
          STORAGE_KEYS.MESSAGE_CONSOLE_LOG_ENABLED,
          STORAGE_KEYS.MESSAGE_DEBUG_BREAK_ENABLED,
          STORAGE_KEYS.MESSAGE_DEBUG_BREAK_MATCH,
          STORAGE_KEYS.MESSAGE_MAX_CAPTURE_SIZE,
          STORAGE_KEYS.FLOOD_PROTECTION_ENABLED
        ],
        (result: Record<string, unknown>) => {
          const settings = normalizeMessageDebugSettings({
            consoleLogEnabled: result[STORAGE_KEYS.MESSAGE_CONSOLE_LOG_ENABLED],
            debugBreakEnabled: result[STORAGE_KEYS.MESSAGE_DEBUG_BREAK_ENABLED],
            debugBreakMatch: result[STORAGE_KEYS.MESSAGE_DEBUG_BREAK_MATCH],
            maxCapturedMessageSize: result[STORAGE_KEYS.MESSAGE_MAX_CAPTURE_SIZE]
          });
          this.messageConsoleLogEnabled = settings.consoleLogEnabled;
          this.messageDebugBreakEnabled = settings.debugBreakEnabled;
          this.messageDebugBreakMatch = settings.debugBreakMatch;
          this.messageMaxCaptureSize = settings.maxCapturedMessageSize;
          this.floodProtectionEnabled = result[STORAGE_KEYS.FLOOD_PROTECTION_ENABLED] !== false;
          resolve();
        }
      );
    });
  }

  saveMessageDebugSettings(
    settings: Partial<MessageDebugSettings> | null | undefined
  ): Promise<void> {
    const normalized = normalizeMessageDebugSettings(settings);
    const consoleLogEnabled = normalized.consoleLogEnabled;
    const debugBreakEnabled = normalized.debugBreakEnabled;
    const debugBreakMatch = normalized.debugBreakMatch;
    const maxCapturedMessageSize = normalized.maxCapturedMessageSize;

    this.messageConsoleLogEnabled = consoleLogEnabled;
    this.messageDebugBreakEnabled = debugBreakEnabled;
    this.messageDebugBreakMatch = debugBreakMatch;
    this.messageMaxCaptureSize = maxCapturedMessageSize;

    return new Promise((resolve) => {
      chrome.storage.local.set(
        {
          [STORAGE_KEYS.MESSAGE_CONSOLE_LOG_ENABLED]: consoleLogEnabled,
          [STORAGE_KEYS.MESSAGE_DEBUG_BREAK_ENABLED]: debugBreakEnabled,
          [STORAGE_KEYS.MESSAGE_DEBUG_BREAK_MATCH]: debugBreakMatch,
          [STORAGE_KEYS.MESSAGE_MAX_CAPTURE_SIZE]: maxCapturedMessageSize
        },
        () => {
          resolve();
        }
      );
    });
  }

  saveFloodProtectionSetting(enabled: boolean): Promise<void> {
    this.floodProtectionEnabled = enabled !== false;
    return new Promise((resolve) => {
      chrome.storage.local.set(
        { [STORAGE_KEYS.FLOOD_PROTECTION_ENABLED]: this.floodProtectionEnabled },
        () => {
          resolve();
        }
      );
    });
  }

  // Load regex patterns from storage
  loadRegexPatterns(): Promise<void> {
    return new Promise((resolve) => {
      chrome.storage.local.get([STORAGE_KEYS.BLOCKED_REGEX], (result: Record<string, unknown>) => {
        this.blockedRegex = normalizeStringArray(result[STORAGE_KEYS.BLOCKED_REGEX]).slice(0, MAX_USER_REGEX_RULES);
        this.compileRegexPatterns();
        storageLog.info('Fransceiver: Loaded regex patterns:', this.blockedRegex.length);
        resolve();
      });
    });
  }

  loadGrepExtractRegex(): Promise<void> {
    return new Promise((resolve) => {
      chrome.storage.local.get([STORAGE_KEYS.GREP_EXTRACT_REGEX], (result: Record<string, unknown>) => {
        this.grepExtractRegex = normalizeString(
          result[STORAGE_KEYS.GREP_EXTRACT_REGEX],
          'https?://[^\\s"\'<>)]+'
        );
        resolve();
      });
    });
  }

  saveGrepExtractRegex(regex: string): void {
    this.grepExtractRegex = regex;
    void chrome.storage.local.set({ [STORAGE_KEYS.GREP_EXTRACT_REGEX]: regex });
  }

  loadMatchReplaceRules(): Promise<void> {
    return new Promise((resolve) => {
      chrome.storage.local.get(
        [STORAGE_KEYS.MATCH_REPLACE_RULES, STORAGE_KEYS.MATCH_REPLACE_RULES_TEXT],
        (result: Record<string, unknown>) => {
          this.matchReplaceRules = normalizeMatchReplaceRules(
            result[STORAGE_KEYS.MATCH_REPLACE_RULES]
          );
          this.matchReplaceRulesText = normalizeString(
            result[STORAGE_KEYS.MATCH_REPLACE_RULES_TEXT],
            ''
          );
          resolve();
        }
      );
    });
  }

  parseMatchReplaceText(text: string): MatchReplaceRule[] {
    return text
      .split('\n')
      .map((line: string) => line.trim())
      .filter((line: string) => line.length > 0)
      .map((line: string) => {
        const parts = line.split('=>');
        if (parts.length < 2) return null;

        const pattern = parts[0].trim();
        const replacement = parts.slice(1).join('=>').trim();
        if (!pattern) return null;

        return { pattern, replacement };
      })
      .filter((rule): rule is MatchReplaceRule => !!rule);
  }

  saveMatchReplaceRules(rules: MatchReplaceRule[], text: string): void {
    this.matchReplaceRules = rules;
    this.matchReplaceRulesText = text;
    void chrome.storage.local.set({
      [STORAGE_KEYS.MATCH_REPLACE_RULES]: rules,
      [STORAGE_KEYS.MATCH_REPLACE_RULES_TEXT]: text
    });
  }

  // Compile regex patterns for performance
  compileRegexPatterns(): void {
    this.invalidateBlockMemo();
    this.compiledRegex = [];
    for (const pattern of this.blockedRegex) {
      const compiled = compileSafeRegex(pattern, 'i');
      if (compiled.regex) {
        this.compiledRegex.push({
          pattern,
          regex: compiled.regex
        });
      } else {
        storageLog.warn('Fransceiver: Rejected unsafe or invalid regex pattern:', pattern, compiled.error);
      }
    }
    storageLog.info('Fransceiver: Compiled regex patterns:', this.compiledRegex.length);
  }

  // Save regex patterns to storage
  saveRegexPatterns(patterns: string[]): void {
    this.blockedRegex = patterns.slice(0, MAX_USER_REGEX_RULES);
    this.compileRegexPatterns();
    void chrome.storage.local.set({
      [STORAGE_KEYS.BLOCKED_REGEX]: this.blockedRegex
    });
  }

  // Parse regex patterns from text (one per line, ignore empty lines)
  parseRegexText(text: string): string[] {
    return text
      .split('\n')
      .map((line: string) => line.trim())
      .filter((line: string) => line.length > 0);
  }

  // Check if listener matches any regex pattern
  isListenerMatchedByRegex(listener: ListenerRecord): string | null {
    if (!listener.listener || this.compiledRegex.length === 0) {
      return null;
    }

    for (const compiled of this.compiledRegex) {
      try {
        if (compiled.regex.test(limitRegexInput(listener.listener))) {
          return compiled.pattern;
        }
      } catch (error) {
        storageLog.warn(
          'Fransceiver: Error testing regex pattern:',
          compiled.pattern,
          error
        );
      }
    }

    return null;
  }

  // Load code display settings
  loadCodeSettings(): Promise<void> {
    return new Promise((resolve) => {
      chrome.storage.local.get(
        ['expandThreshold', 'maxLines', 'codeFontSize'],
        (result: Record<string, unknown>) => {
          const expandThreshold = Number(result.expandThreshold);
          const maxLines = Number(result.maxLines);
          const codeFontSize = Number(result.codeFontSize);

          this.expandThreshold = Number.isFinite(expandThreshold) ? expandThreshold : 4000;
          this.maxLines = Number.isFinite(maxLines) ? maxLines : 40;
          this.codeFontSize = Number.isFinite(codeFontSize) ? codeFontSize : 12;
          resolve();
        }
      );
    });
  }

  // Save code display settings
  saveCodeSettings(): void {
    void chrome.storage.local.set({
      expandThreshold: this.expandThreshold,
      maxLines: this.maxLines,
      codeFontSize: this.codeFontSize
    });
  }

  // Load settings from storage
  loadDedupeSetting(): Promise<void> {
    return new Promise((resolve) => {
      chrome.storage.local.get([STORAGE_KEYS.DEDUPE_ENABLED], (result: Record<string, unknown>) => {
        this.dedupeEnabled = normalizeBoolean(result[STORAGE_KEYS.DEDUPE_ENABLED], true);
        storageLog.info('Fransceiver: Loaded dedupe setting:', this.dedupeEnabled);
        resolve();
      });
    });
  }

  loadPrettifySetting(): Promise<void> {
    return new Promise((resolve) => {
      chrome.storage.local.get(['prettifyEnabled'], (result: Record<string, unknown>) => {
        this.prettifyEnabled = normalizeBoolean(result.prettifyEnabled, false);
        resolve();
      });
    });
  }

  loadHighlightRules(): Promise<void> {
    return new Promise((resolve) => {
      chrome.storage.local.get(['highlightRules'], (result: Record<string, unknown>) => {
        const maybeRules = result.highlightRules;
        if (typeof maybeRules === 'object' && maybeRules !== null) {
          this.highlightRules = maybeRules as HighlightRules;
        }
        resolve();
      });
    });
  }

  loadBlocklists(): Promise<void> {
    return new Promise((resolve) => {
      chrome.storage.local.get(
        [STORAGE_KEYS.BLOCKED_LISTENERS, STORAGE_KEYS.BLOCKED_URLS],
        (result: Record<string, unknown>) => {
          this.blockedListeners = normalizeStringArray(result[STORAGE_KEYS.BLOCKED_LISTENERS]);
          this.blockedUrls = normalizeStringArray(result[STORAGE_KEYS.BLOCKED_URLS]);
          this.invalidateBlockMemo();
          resolve();
        }
      );
    });
  }

  loadLogUrl(): Promise<void> {
    return new Promise((resolve) => {
      chrome.storage.local.get([STORAGE_KEYS.LOG_URL], (result: Record<string, unknown>) => {
        this.originalLogUrl = normalizeString(result[STORAGE_KEYS.LOG_URL], '');
        resolve();
      });
    });
  }

  // Save settings to storage
  saveDedupeSetting(enabled: boolean): Promise<void> {
    return new Promise((resolve) => {
      this.dedupeEnabled = enabled;
      chrome.storage.local.set({ [STORAGE_KEYS.DEDUPE_ENABLED]: enabled }, () => {
        storageLog.info('Fransceiver: Saved dedupe setting:', enabled);

        // Also notify background script
        chrome.runtime.sendMessage(
          {
            action: 'updateDedupeSetting',
            enabled
          },
          () => {
            if (chrome.runtime.lastError) {
              storageLog.error(
                'Fransceiver: Error updating dedupe setting:',
                chrome.runtime.lastError
              );
            } else {
              storageLog.info('Fransceiver: Background script updated dedupe setting');
            }
            resolve();
          }
        );
      });
    });
  }

  savePrettifySetting(enabled: boolean): Promise<void> {
    return new Promise((resolve) => {
      this.prettifyEnabled = enabled;
      chrome.storage.local.set({ prettifyEnabled: enabled }, () => {
        resolve();
      });
    });
  }

  saveBlocklists(): void {
    this.invalidateBlockMemo();
    void chrome.storage.local.set({
      [STORAGE_KEYS.BLOCKED_LISTENERS]: this.blockedListeners,
      [STORAGE_KEYS.BLOCKED_URLS]: this.blockedUrls
    });
  }

  saveHighlightRules(rules: HighlightRules, rulesText: string): void {
    this.highlightRules = rules;
    void chrome.storage.local.set({
      highlightRules: rules,
      highlightRulesText: rulesText
    });
  }

  saveLogUrl(logUrl: string): Promise<void> {
    return new Promise((resolve) => {
      chrome.storage.local.set({ [STORAGE_KEYS.LOG_URL]: logUrl }, () => {
        this.originalLogUrl = logUrl;
        resolve();
      });
    });
  }

  cleanUrl(url: string): string {
    return cleanUrl(url);
  }

  extractJsUrlFromStack(stack?: string, fullstack?: string[]): string | null {
    return extractJsUrlFromStack(stack, fullstack);
  }

  // Invalidate the memoized isListenerBlocked results. Call whenever the
  // blocklists or regex patterns change.
  invalidateBlockMemo(): void {
    this.blockMemo.clear();
  }

  // Enhanced: Check if listener is blocked (includes regex check).
  // Memoized by listenerKey - this runs per listener per render across
  // getFilteredListeners, getFindingsCount, buildFindingsList, and
  // createListenerElement, and each call regex-tests the full source.
  isListenerBlocked(listener: ListenerRecord): BlockMatch | null {
    const key = typeof listener.listenerKey === 'string' ? listener.listenerKey : null;
    if (key && this.blockMemo.has(key)) {
      return this.blockMemo.get(key) ?? null;
    }
    const result = this.computeListenerBlocked(listener);
    if (key) {
      this.blockMemo.set(key, result);
    }
    return result;
  }

  private computeListenerBlocked(listener: ListenerRecord): BlockMatch | null {
    // Check if listener code is blocked
    if (this.blockedListeners.includes(listener.listener)) {
      return { type: 'listener', value: listener.listener };
    }

    // Check if JS file URL is blocked (with cleaned URL)
    const jsUrl = this.extractJsUrlFromStack(listener.stack, listener.fullstack);
    if (jsUrl && this.blockedUrls.includes(jsUrl)) {
      return { type: 'url', value: jsUrl };
    }

    // Check if listener matches any regex pattern
    const matchedPattern = this.isListenerMatchedByRegex(listener);
    if (matchedPattern) {
      return { type: 'regex', value: matchedPattern };
    }

    return null;
  }

  // Add/remove from blocklist
  addToBlocklist(type: 'listener' | 'url', value: string): void {
    if (type === 'listener' && !this.blockedListeners.includes(value)) {
      this.blockedListeners.push(value);
    } else if (type === 'url' && !this.blockedUrls.includes(value)) {
      // Clean the URL before adding to blocklist
      const cleanedUrl = this.cleanUrl(value);
      if (cleanedUrl && !this.blockedUrls.includes(cleanedUrl)) {
        this.blockedUrls.push(cleanedUrl);
      }
    }

    this.saveBlocklists();
  }

  removeFromBlocklist(type: 'listener' | 'url', value: string): void {
    if (type === 'listener') {
      this.blockedListeners = this.blockedListeners.filter((listener) => listener !== value);
    } else if (type === 'url') {
      // Clean the URL before removing from blocklist
      const cleanedUrl = this.cleanUrl(value);
      this.blockedUrls = this.blockedUrls.filter((url) => url !== cleanedUrl);
    }

    this.saveBlocklists();
  }

  // Export/import functionality
  exportData(data: unknown, filename: string): void {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  exportBlockedUrls(): void {
    const data = {
      blockedUrls: this.blockedUrls,
      exportDate: new Date().toISOString(),
      version: '1.0'
    };
    this.exportData(data, 'fransceiver-blocked-urls.json');
  }

  exportBlockedListeners(): void {
    const data = {
      blockedListeners: this.blockedListeners,
      exportDate: new Date().toISOString(),
      version: '1.0'
    };
    this.exportData(data, 'fransceiver-blocked-listeners.json');
  }

  // Export regex patterns
  exportBlockedRegex(): void {
    const data = {
      blockedRegex: this.blockedRegex,
      exportDate: new Date().toISOString(),
      version: '1.0'
    };
    this.exportData(data, 'fransceiver-blocked-regex.json');
  }

  importData(file: File, callback: ImportDataCallback): void {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        if (typeof reader.result !== 'string') {
          callback(new Error('Invalid file contents'));
          return;
        }

        const parsed = JSON.parse(reader.result) as unknown;
        if (typeof parsed !== 'object' || parsed === null) {
          callback(new Error('Invalid file format'));
          return;
        }

        callback(null, parsed as Record<string, unknown>);
      } catch (err) {
        callback(err instanceof Error ? err : new Error('Invalid JSON'));
      }
    };
    reader.readAsText(file);
  }

  importBlockedUrls(file: File, callback: ImportResultCallback): void {
    this.importData(file, (err, data) => {
      if (err) {
        callback(err);
        return;
      }

      const blockedUrls = data && Array.isArray(data.blockedUrls)
        ? data.blockedUrls.filter((url): url is string => typeof url === 'string')
        : null;

      if (blockedUrls) {
        this.blockedUrls = blockedUrls;
        this.saveBlocklists();
        callback(null, `Imported ${this.blockedUrls.length} blocked URLs`);
      } else {
        callback(new Error('Invalid file format'));
      }
    });
  }

  importBlockedListeners(file: File, callback: ImportResultCallback): void {
    this.importData(file, (err, data) => {
      if (err) {
        callback(err);
        return;
      }

      const blockedListeners = data && Array.isArray(data.blockedListeners)
        ? data.blockedListeners.filter((listener): listener is string => typeof listener === 'string')
        : null;

      if (blockedListeners) {
        this.blockedListeners = blockedListeners;
        this.saveBlocklists();
        callback(null, `Imported ${this.blockedListeners.length} blocked listeners`);
      } else {
        callback(new Error('Invalid file format'));
      }
    });
  }

  // Import regex patterns
  importBlockedRegex(file: File, callback: ImportResultCallback): void {
    this.importData(file, (err, data) => {
      if (err) {
        callback(err);
        return;
      }

      const blockedRegex = data && Array.isArray(data.blockedRegex)
        ? data.blockedRegex.filter((pattern): pattern is string => typeof pattern === 'string')
        : null;

      if (blockedRegex) {
        this.saveRegexPatterns(blockedRegex);
        callback(null, `Imported ${this.blockedRegex.length} regex patterns`);
      } else {
        callback(new Error('Invalid file format'));
      }
    });
  }

  // Clear functions
  clearBlockedUrls(): void {
    this.blockedUrls = [];
    this.saveBlocklists();
  }

  clearBlockedListeners(): void {
    this.blockedListeners = [];
    this.saveBlocklists();
  }

  // Clear regex patterns
  clearBlockedRegex(): void {
    this.blockedRegex = [];
    this.compiledRegex = [];
    this.invalidateBlockMemo();
    void chrome.storage.local.set({
      [STORAGE_KEYS.BLOCKED_REGEX]: []
    });
  }
}

(globalThis as unknown as { PanelStorage: typeof PanelStorage }).PanelStorage = PanelStorage;
