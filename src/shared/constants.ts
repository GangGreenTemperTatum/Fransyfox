(() => {
  'use strict';

  const STORAGE_KEYS = {
    DEDUPE_ENABLED: 'dedupeEnabled',
    EXTENSION_ACTIVE: 'extensionActive',
    BLOCKED_LISTENERS: 'blockedListeners',
    BLOCKED_URLS: 'blockedUrls',
    BLOCKED_REGEX: 'blockedRegex',
    LOG_URL: 'log_url',
    MESSAGE_BEAUTIFY_ENABLED: 'messageBeautifyEnabled',
    MESSAGE_CONSOLE_LOG_ENABLED: 'messageConsoleLogEnabled',
    MESSAGE_DEBUG_BREAK_ENABLED: 'messageDebugBreakEnabled',
    MESSAGE_DEBUG_BREAK_MATCH: 'messageDebugBreakMatch',
    MESSAGE_MAX_CAPTURE_SIZE: 'messageMaxCaptureSize',
    FLOOD_PROTECTION_ENABLED: 'floodProtectionEnabled',
    MESSAGE_QUERY: 'messageQuery',
    MESSAGE_TARGET_FRAME: 'messageTargetFrame',
    MESSAGE_SORT_ORDER: 'messageSortOrder',
    MESSAGE_ALL_EXPANDED: 'messageAllExpanded',
    PANEL_VIEW_MODE: 'panelViewMode',
    MATCH_REPLACE_RULES: 'matchReplaceRules',
    MATCH_REPLACE_RULES_TEXT: 'matchReplaceRulesText',
    PRESERVE_LOG_ENABLED: 'preserveLogEnabled',
    GREP_EXTRACT_REGEX: 'grepExtractRegex',
    COMPOSER_HISTORY: 'composerHistory'
  } as const;

  const CONTENT_TYPE_JSON = 'application/json; charset=UTF-8';

  const EXTENSION_BLACKLIST = [
    'wappalyzer',
    'react-devtools',
    'vue-devtools',
    'domlogger',
    'event-tracker',
    'event-tracker-page-hook',
    'event-tracker-content-hook',
    'bitwarden-webauthn',
    'POSTMESSAGE_TRACKER_DATA',
    'Fransceiver:',
    'FransyTracker:',
    '__postmessagetrackername__'
  ] as const;

  type FransceiverConstantsType = {
    STORAGE_KEYS: typeof STORAGE_KEYS;
    CONTENT_TYPE_JSON: string;
    EXTENSION_BLACKLIST: readonly string[];
  };

  const globalObj = globalThis as typeof globalThis & {
    FransceiverConstants?: Partial<FransceiverConstantsType>;
  };

  globalObj.FransceiverConstants = Object.assign(globalObj.FransceiverConstants || {}, {
    STORAGE_KEYS,
    CONTENT_TYPE_JSON,
    EXTENSION_BLACKLIST
  });
})();
