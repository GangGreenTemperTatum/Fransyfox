import type { ListenerRecord, MessageEventRecord } from './types/listener';
import type { MatchReplaceRule } from './types/settings';

declare global {
  var FransceiverConstants: {
    STORAGE_KEYS: {
      DEDUPE_ENABLED: string;
      EXTENSION_ACTIVE: string;
      BLOCKED_LISTENERS: string;
      BLOCKED_URLS: string;
      BLOCKED_REGEX: string;
      LOG_URL: string;
      MESSAGE_BEAUTIFY_ENABLED: string;
      MESSAGE_CONSOLE_LOG_ENABLED: string;
      MESSAGE_DEBUG_BREAK_ENABLED: string;
      MESSAGE_DEBUG_BREAK_MATCH: string;
      MESSAGE_MAX_CAPTURE_SIZE: string;
      FLOOD_PROTECTION_ENABLED: string;
      MESSAGE_QUERY: string;
      MESSAGE_TARGET_FRAME: string;
      MESSAGE_SORT_ORDER: string;
      MESSAGE_ALL_EXPANDED: string;
      PANEL_VIEW_MODE: string;
      MATCH_REPLACE_RULES: string;
      MATCH_REPLACE_RULES_TEXT: string;
      PRESERVE_LOG_ENABLED: string;
      GREP_EXTRACT_REGEX: string;
      COMPOSER_HISTORY: string;
    };
    CONTENT_TYPE_JSON: string;
    EXTENSION_BLACKLIST: string[];
  };

  var FransceiverUrlUtils: {
    cleanUrl: (url: string) => string;
    extractJsUrlFromStack: (stack?: string, fullstack?: string[]) => string | null;
  };

  var FransceiverMessages: {
    PORT: {
      REQUEST_STATE: 'REQUEST_STATE';
      STATE: 'STATE';
      REQUEST_EVENTS: 'REQUEST_EVENTS';
      EVENTS: 'EVENTS';
      EVENTS_APPEND: 'EVENTS_APPEND';
      CLEAR_EVENTS: 'CLEAR_EVENTS';
      EVENTS_CLEARED: 'EVENTS_CLEARED';
      CLEAR_LISTENERS: 'CLEAR_LISTENERS';
      LISTENERS_CLEARED: 'LISTENERS_CLEARED';
      REQUEST_FRAME_TREE: 'REQUEST_FRAME_TREE';
      FRAME_TREE: 'FRAME_TREE';
    };
  };

  var FransceiverLogger: {
    scoped: (scope?: string) => {
      debug: (...args: unknown[]) => void;
      info: (...args: unknown[]) => void;
      warn: (...args: unknown[]) => void;
      error: (...args: unknown[]) => void;
    };
    setLevel: (levelName: string) => void;
  };

  var FransceiverEventStore: {
    createEventStore: (options?: { maxEvents?: number }) => {
      add: (event: Record<string, unknown>) => Record<string, unknown> | null;
      all: () => Array<Record<string, unknown>>;
      clear: () => void;
      size: () => number;
      exportJson: () => string;
    };
    createPersistentEventStore: (options?: {
      maxEvents?: number;
      maxDataChars?: number;
      databaseName?: string;
      storeName?: string;
      snapshotKey?: string;
      saveDelayMs?: number;
      adapter?: {
        load: () => Promise<{
          events?: Array<Record<string, unknown>>;
          nextId?: number;
          version?: number;
          tabNavigationIds?: Record<string, number>;
        } | null>;
        save: (snapshot: {
          events?: Array<Record<string, unknown>>;
          nextId?: number;
          version?: number;
          tabNavigationIds?: Record<string, number>;
        }) => Promise<void>;
      };
    }) => {
      init: () => Promise<void>;
      add: (event: Record<string, unknown>) => Promise<{
        event: Record<string, unknown>;
        evicted: Array<Record<string, unknown>>;
        fromVersion: number;
        version: number;
      } | null>;
      all: () => Promise<Array<Record<string, unknown>>>;
      clear: () => Promise<{ clearedCount: number; version: number }>;
      clearTab: (tabId?: number | string | null) => Promise<{ clearedCount: number; version: number }>;
      removeTab: (tabId?: number | string | null) => Promise<{ clearedCount: number; version: number }>;
      getNavigationId: (tabId?: number | string | null) => number;
      advanceNavigation: (tabId?: number | string | null) => Promise<{ navigationId: number; version: number }>;
      size: () => number;
      getVersion: () => number;
      getMaxEvents: () => number;
      getMaxDataChars: () => number;
      wasHydrated: () => boolean;
      flushNow: () => Promise<void>;
      exportJson: () => Promise<string>;
    };
  };

  var FransceiverFindings: {
    version: number;
    evaluateListener: (listener: Record<string, unknown>) => {
      findings: Array<{ id: string; [key: string]: unknown }>;
      errors: Array<{ ruleId: string; message: string }>;
    };
    getRuleById: (id: string) => Record<string, unknown> | null;
    listRules: () => Array<Record<string, unknown>>;
  };

  type PanelFindingsFilters = {
    query: string;
    severity: string;
    listenerKey: string | null;
  };

  type PanelStorageInstance = {
    init: () => Promise<void>;
    matchReplaceRules: MatchReplaceRule[];
    matchReplaceRulesText: string;
    messageBeautifyEnabled: boolean;
    messageQuery: string;
    messageTargetFrame: string;
    messageSortOrder: 'asc' | 'desc';
    messageAllExpanded: boolean;
    panelViewMode: 'listeners' | 'messages' | 'findings' | 'match' | 'map' | 'timeline';
    originalLogUrl: string;
    prettifyEnabled: boolean;
    dedupeEnabled: boolean;
    syntaxHighlightEnabled: boolean;
    expandThreshold: number;
    maxLines: number;
    codeFontSize: number;
    messageConsoleLogEnabled: boolean;
    messageDebugBreakEnabled: boolean;
    messageDebugBreakMatch: string;
    parseMatchReplaceText: (text: string) => MatchReplaceRule[];
    saveMatchReplaceRules: (rules: MatchReplaceRule[], text: string) => void;
    saveMessageBeautifySetting: (enabled: boolean) => Promise<void>;
    savePanelViewMode: (mode: 'listeners' | 'messages' | 'findings' | 'match' | 'map' | 'timeline') => Promise<void>;
    saveMessageViewSettings: (settings: {
      query?: string;
      targetFrame?: string;
      sortOrder?: 'asc' | 'desc';
      allExpanded?: boolean;
    }) => Promise<void>;
    extractJsUrlFromStack: (stack?: string, fullstack?: string[]) => string | null;
    isListenerBlocked: (listener: ListenerRecord) => unknown;
    parseRegexText: (text: string) => string[];
    saveRegexPatterns: (patterns: string[]) => void;
    saveHighlightRules: (rules: Record<string, string[]>, rulesText: string) => void;
    saveLogUrl: (logUrl: string) => Promise<void>;
    savePrettifySetting: (enabled: boolean) => Promise<void>;
    saveSyntaxHighlightSetting: (enabled: boolean) => Promise<void>;
    saveDedupeSetting: (enabled: boolean) => Promise<void>;
    saveCodeSettings: () => void;
    saveMessageDebugSettings: (settings: {
      consoleLogEnabled: boolean;
      debugBreakEnabled: boolean;
      debugBreakMatch: string;
    }) => Promise<void>;
    exportBlockedUrls: () => void;
    importBlockedUrls: (
      file: File,
      callback: (err: Error | null, message?: string) => void
    ) => void;
    clearBlockedUrls: () => void;
    exportBlockedListeners: () => void;
    importBlockedListeners: (
      file: File,
      callback: (err: Error | null, message?: string) => void
    ) => void;
    clearBlockedListeners: () => void;
  };

  type PanelUIInstance = {
    showBlockedOnly: boolean;
    setFindingsHandler: (handler: (listener: ListenerRecord) => void) => void;
    setListenerFocusHandler: (handler: (listener: ListenerRecord) => void) => void;
    displayListeners: (
      listeners: ListenerRecord[],
      currentUrl: string,
      onRefresh: () => void | Promise<void>,
      preserveScroll?: boolean,
      onShowFindings?: ((listener: ListenerRecord) => void) | null,
      focusListenerKey?: string | null,
      reverseNumbering?: boolean
    ) => void;
    displayMessages: (
      messages: MessageEventRecord[],
      currentUrl: string,
      onRefresh: () => void | Promise<void>,
      preserveScroll: boolean,
      state?: {
        emptyReason: 'none' | 'navigation' | 'manual' | 'eviction' | 'restored';
        restored: boolean;
        maxEvents: number;
      }
    ) => void;
    displayFindings: (
      listeners: ListenerRecord[],
      currentUrl: string,
      preserveScroll: boolean,
      filters: PanelFindingsFilters
    ) => void;
    reHighlightCodeBlocks: (forceRebuild: boolean) => void;
    clearPrettifyCache: () => void;
    updateShowBlockedButton: () => void;
    toggleShowBlocked: () => void;
    toggleAllMessagesExpanded: () => boolean;
    setAllMessagesExpanded: (expanded: boolean) => void;
    areAllMessagesExpanded: () => boolean;
    focusMessage: (messageId: number) => boolean;
    buildFindingsList: (listeners: ListenerRecord[], excludeBlocked?: boolean) => Array<{
      rule?: Record<string, unknown>;
      finding?: Record<string, unknown>;
      listener?: ListenerRecord;
    }>;
    applyFindingsFilters: (
      findings: Array<{ rule?: Record<string, unknown>; finding?: Record<string, unknown>; listener?: ListenerRecord }>,
      filters: PanelFindingsFilters | null
    ) => Array<{ rule?: Record<string, unknown>; finding?: Record<string, unknown>; listener?: ListenerRecord }>;
  };

  type PanelModalsInstance = {
    setRefreshHandler: (handler: (isManual: boolean) => void | Promise<void>) => void;
    setReHighlightHandler: (handler: (forceRebuild: boolean) => void) => void;
    setClearPrettifyCacheHandler: (handler: () => void) => void;
    init: () => void;
  };

  var PanelStorage: new (...args: unknown[]) => PanelStorageInstance;
  var PanelUI: new (...args: unknown[]) => PanelUIInstance;
  var PanelUIMap: new (...args: unknown[]) => {
    render: (
      frames: import('./types/listener').FrameNode[],
      messages: MessageEventRecord[],
      options?: { selectedFrameId?: number | null }
    ) => void;
    setSelectHandler: (handler: (frameId: number | null) => void) => void;
  };
  var PanelUITimeline: new (...args: unknown[]) => {
    render: (
      frames: import('./types/listener').FrameNode[],
      messages: MessageEventRecord[],
      options?: { highlightId?: number | null }
    ) => void;
    setSelectHandler: (handler: (messageId: number) => void) => void;
  };
  var PanelUIMessages: new (...args: unknown[]) => unknown;
  var PanelUIFindings: new (...args: unknown[]) => unknown;
  var PanelModals: new (...args: unknown[]) => PanelModalsInstance;
  var PanelMain: new (...args: unknown[]) => { init: () => Promise<void>; destroy: () => void };

  interface Window {
    FransceiverMainLoaded?: boolean;
    FransceiverBridgeLoaded?: boolean;
    expando?: string;
    events?: any;
    __lookupSetter__?: (prop: string) => ((value: any) => void) | undefined;
    __defineSetter__?: (prop: string, setter: (value: any) => void) => void;
    [key: string]: any;
  }

  interface MessagePort {
    __postmessagetrackername__?: boolean;
  }

  const hljs: {
    configure: (options: Record<string, unknown>) => void;
    highlightElement: (element: Element) => void;
  };
}

export {};
