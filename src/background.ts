import { parsePortRequestMessage, parseRuntimeRequestMessage } from './contracts/messages';
import { compileBlacklist, matchesBlacklistText as matchesCompiledBlacklist } from './shared/blacklist-matcher';
import { closePanelSurface, configureTabPanelSurface, configureTabPanelSurfaceWithCallback, getPanelSurfaceKind, initializePanelSurface, onPanelSurfaceClosed, onPanelSurfaceOpened, openPanelSurface, toggleSidebarSurface } from './shared/browser-env';
import './shared/constants';
import './shared/url-utils';
import './shared/messages';
import './shared/logger';
import './shared/event-store';
import './shared/findings';
import {
    MAX_LISTENERS_PER_TAB,
    MAX_LISTENERS_TOTAL,
    compareListenerEvictionPriority,
    getListenerSourceIdentity,
    sanitizeListenerRecord
} from './shared/listener-limits';
import { createKeyedTaskScheduler } from './shared/keyed-task-scheduler';
import { registerInitializedPort } from './shared/initialized-port';
import { MAX_USER_REGEX_RULES, compileSafeRegex, limitRegexInput } from './shared/safe-regex';
import { normalizeBoolean, normalizeMatchReplaceRules, normalizeMessageDebugSettings, normalizeString, normalizeStringArray } from './contracts/state';
import type { ListenerRecord, MessageEventRecord, FrameNode, FrameSeverity } from './types/listener';
import type { MatchReplaceRule, MessageDebugSettings } from './types/settings';
// Background script for Fransyfox - V3 with State Persistence Fix and Regex Support
const { STORAGE_KEYS, CONTENT_TYPE_JSON, EXTENSION_BLACKLIST } = FransyfoxConstants;
const { extractJsUrlFromStack } = FransyfoxUrlUtils;
const { PORT: PORT_MESSAGES } = FransyfoxMessages;
const log = FransyfoxLogger.scoped('background');
const EVENT_STORE_MAX_EVENTS = 5000;
const EVENT_STORE_MAX_DATA_CHARS = 16 * 1024 * 1024;
const EVENT_APPEND_NOTIFY_DELAY_MS = 100;
const eventStore = FransyfoxEventStore.createPersistentEventStore({
    maxEvents: EVENT_STORE_MAX_EVENTS,
    maxDataChars: EVENT_STORE_MAX_DATA_CHARS,
    databaseName: 'FransyfoxMessageEvents',
    storeName: 'snapshots',
    snapshotKey: 'messages',
    // Snapshot writes clone-free but still cover the whole buffer; throttle
    // them well below the event rate. onSuspend flushes the tail.
    saveDelayMs: 2000
});
const eventStoreReadyPromise = eventStore.init();
interface CompiledRegexEntry {
    pattern: string;
    regex: RegExp;
}
interface EventAppendResult {
    event: Record<string, unknown>;
    evicted: Array<Record<string, unknown>>;
    fromVersion: number;
    version: number;
}
interface ExtensionActiveOptions {
    persist?: boolean;
    forceSync?: boolean;
}
interface AddListenerResult {
    added: boolean;
    changedTabIds: number[];
}
const CONTENT_SCRIPT_IDS: Record<string, string> = {
    MAIN: 'fransyfox-main-world',
    BRIDGE: 'fransyfox-bridge-world'
};
const DYNAMIC_CONTENT_SCRIPTS: chrome.scripting.RegisteredContentScript[] = [
    {
        id: CONTENT_SCRIPT_IDS.MAIN,
        matches: ['<all_urls>'],
        js: ['main.js'],
        runAt: 'document_start',
        allFrames: true,
        world: 'MAIN'
    },
    {
        id: CONTENT_SCRIPT_IDS.BRIDGE,
        matches: ['<all_urls>'],
        js: ['shared/constants.js', 'bridge.js'],
        runAt: 'document_start',
        allFrames: true,
        world: 'ISOLATED'
    }
];
// IMPORTANT: Only listener records are persisted. Dedupe keys are compact,
// derived state rebuilt at startup rather than a second copy in storage.
// Navigation state (tab_push, tab_lasturl) is NOT persisted to avoid double-listener bugs
// Global variables - will be restored from storage
let tab_listeners: Record<string, ListenerRecord[]> = {};
let tab_listener_keys: Record<string, Set<string>> = {};
let tab_push: Record<string, boolean> = {};
let tab_lasturl: Record<string, boolean> = {};
let selectedId = -1;
let connectedPorts: chrome.runtime.Port[] = [];
let dedupeEnabled = true; // Default: enabled
let preserveLogEnabled = false; // Default: disabled
let extensionActive = true; // Default: enabled
let blockedListeners: string[] = [];
let blockedUrls: string[] = [];
let blockedRegex: string[] = [];
let matchReplaceRules: MatchReplaceRule[] = [];
let compiledRegex: CompiledRegexEntry[] = []; // Compiled regex patterns for performance
let messageConsoleLogEnabled = false;
let messageDebugBreakEnabled = false;
let messageDebugBreakMatch = '';
let messageMaxCaptureSize = 0; // 0 = automatic 64K capture limit
let contentScriptSyncPromise = Promise.resolve();
// Panels are tab-scoped: each connected port maps to a tab, and STATE
// messages carry only that tab's listeners. Versions are tracked per tab so
// changes in one tab don't invalidate another tab's panel.
const portTabIds = new Map<chrome.runtime.Port, number>();
function removePanelPort(port: chrome.runtime.Port): void {
    connectedPorts = connectedPorts.filter((candidate) => candidate !== port);
    portTabIds.delete(port);
}
const tabDataVersions: Record<string, number> = {};
function bumpTabDataVersion(tabId: number | string) {
    const key = String(tabId);
    tabDataVersions[key] = (tabDataVersions[key] || 0) + 1;
}
function getTabDataVersion(tabId: number | string | null): number {
    return tabId === null ? 0 : (tabDataVersions[String(tabId)] || 0);
}
// Compiled once at startup - EXTENSION_BLACKLIST is a build-time constant.
const compiledExtensionBlacklist = compileBlacklist(EXTENSION_BLACKLIST);
// Blacklist tokens and tracker envelopes appear near the start of real
// payloads; cap how much of a message's dataText is scanned for filtering.
// Filtering scope only - the full dataText is still stored and displayed.
const MAX_BLACKLIST_SCAN_LENGTH = 4096;
function capForScan(value: string | null | undefined): string {
    if (typeof value !== 'string') return '';
    return value.length > MAX_BLACKLIST_SCAN_LENGTH ? value.slice(0, MAX_BLACKLIST_SCAN_LENGTH) : value;
}
function asRecord(value: unknown): Record<string, unknown> | null {
    if (typeof value !== 'object' || value === null) {
        return null;
    }
    return value as Record<string, unknown>;
}
function isIgnoredEnvelopeRecord(record: Record<string, unknown>): boolean {
    const source = typeof record.source === 'string' ? record.source.toLowerCase() : '';
    if (source.startsWith('event-tracker-') || source.startsWith('fancytracker')) {
        return true;
    }
    return false;
}
function hasIgnoredEnvelopeInDataText(dataText: string | null | undefined): boolean {
    if (typeof dataText !== 'string' || !dataText.length) {
        return false;
    }
    // Real tracker envelopes are tiny and carry a recognizable source marker;
    // skip the JSON.parse for everything else (this runs per stored event).
    if (dataText.length > 65536) {
        return false;
    }
    const probe = capForScan(dataText).toLowerCase();
    if (!probe.includes('event-tracker') && !probe.includes('fancytracker')) {
        return false;
    }
    try {
        const parsed = JSON.parse(dataText);
        const parsedRecord = asRecord(parsed);
        return !!parsedRecord && isIgnoredEnvelopeRecord(parsedRecord);
    }
    catch {
        return false;
    }
}
function shouldExposeStoredEvent(event: unknown): boolean {
    const eventRecord = asRecord(event);
    if (!eventRecord) {
        return false;
    }
    const kind = typeof eventRecord.kind === 'string' ? eventRecord.kind : '';
    if (kind !== 'message') {
        return true;
    }
    const sourceFrame = typeof eventRecord.sourceFrame === 'string' ? eventRecord.sourceFrame : '';
    const targetFrame = typeof eventRecord.targetFrame === 'string' ? eventRecord.targetFrame : '';
    const origin = typeof eventRecord.origin === 'string' ? eventRecord.origin : '';
    const dataText = typeof eventRecord.dataText === 'string' ? eventRecord.dataText : '';
    if (matchesExtensionBlacklist([sourceFrame, targetFrame, origin, capForScan(dataText)].join(' '))) {
        return false;
    }
    if (hasIgnoredEnvelopeInDataText(dataText)) {
        return false;
    }
    return true;
}
function matchesExtensionBlacklist(value: string, includeExtensionUrl = true): boolean {
    return matchesCompiledBlacklist(compiledExtensionBlacklist, value, includeExtensionUrl);
}
// Simple extension filter
function isFromExtension(listener: ListenerRecord['listener'], stack: string | null | undefined) {
    try {
        const listenerStr = listener.toString();
        const stackStr = stack || '';
        const combined = listenerStr + ' ' + stackStr;
        if (matchesExtensionBlacklist(combined, false)) {
            return true;
        }
    }
    catch (e) {
        // Ignore
    }
    return false;
}
// State Persistence Class
class PersistentState {
    isLoaded: boolean;
    loadPromise: Promise<void>;
    debouncedSave: () => void;
    constructor() {
        this.isLoaded = false;
        this.loadPromise = this.loadState();
        this.debouncedSave = this.throttle(this.saveState.bind(this), 1000);
    }
    async loadState() {
        if (this.isLoaded)
            return;
        try {
            const result = await chrome.storage.local.get(['tab_listeners']);
            // Initialize with stored data or defaults
            tab_listeners = (result.tab_listeners as Record<string, ListenerRecord[]>) || {};
            // Rebuild compact keys from bounded records. Persisted keys from
            // older versions may contain entire function bodies.
            tab_listener_keys = {};
            const listenerStateChanged = normalizeLoadedListenerState();
            // DON'T persist navigation state - reset on service worker restart
            tab_push = {};
            tab_lasturl = {};
            this.isLoaded = true;
            const findingsChanged = backfillFindingsForAllTabs();
            if (listenerStateChanged || findingsChanged) {
                await this.saveState();
            }
            try {
                await chrome.storage.local.remove('tab_listener_keys');
            }
            catch (error) {
                log.warn('Fransyfox: Failed to remove legacy listener keys:', error);
            }
            log.info('Fransyfox: State loaded from storage', {
                tabs: Object.keys(tab_listeners).length,
                totalListeners: Object.values(tab_listeners).reduce((sum, listeners) => sum + listeners.length, 0)
            });
        }
        catch (error) {
            log.error('Fransyfox: Failed to load state from storage:', error);
            this.isLoaded = true; // Continue with empty state
        }
    }
    async saveState() {
        if (!this.isLoaded)
            return;
        try {
            // Only persist listener data, NOT navigation state
            await chrome.storage.local.set({
                tab_listeners
            });
        }
        catch (error) {
            log.error('Fransyfox: Failed to save state to storage:', error);
        }
    }
    // Trailing throttle: unlike a pure debounce, continuous listener traffic
    // cannot starve the save - state is persisted at most (and at least)
    // once per `wait` while changes keep arriving.
    throttle<T extends unknown[]>(func: (...args: T) => void, wait: number) {
        let timeout: ReturnType<typeof setTimeout> | null = null;
        let lastRun = 0;
        return function executedFunction(...args: T) {
            if (timeout) {
                return;
            }
            const delay = Math.max(0, wait - (Date.now() - lastRun));
            timeout = setTimeout(() => {
                timeout = null;
                lastRun = Date.now();
                func(...args);
            }, delay);
        };
    }
}
// Initialize persistent state
const persistentState = new PersistentState();
// Settings initialization promise - resolved when loadSettings completes
let settingsLoadedResolve: () => void = () => undefined;
const settingsLoadedPromise = new Promise<void>((resolve) => {
    settingsLoadedResolve = resolve;
});
// Combined initialization promise - waits for listener state, message state, and settings
const initPromise = Promise.all([
    persistentState.loadPromise,
    eventStoreReadyPromise,
    settingsLoadedPromise
]);
const panelSurfaceKind = getPanelSurfaceKind();
const sidePanelConfiguredTabs = new Set<number>();
const sidePanelOpenTabs = new Set<number>();
// Keep the panel tab-scoped. The action click handler opens the current tab's panel directly.
initializePanelSurface().catch((err: unknown) => {
    log.warn('Failed to disable global side panel:', err);
});
function enableTabSidePanel(tabId: number): Promise<void> {
    if (panelSurfaceKind !== 'sidePanel') {
        return Promise.resolve();
    }
    if (sidePanelConfiguredTabs.has(tabId)) {
        return Promise.resolve();
    }
    return configureTabPanelSurface(tabId, 'panel.html').then(() => {
        sidePanelConfiguredTabs.add(tabId);
    }).catch((err: unknown) => {
        log.warn('Failed to configure side panel for tab:', tabId, err);
    });
}
function enableTabSidePanelFromActionClick(tabId: number, callback: () => void): void {
    configureTabPanelSurfaceWithCallback(tabId, 'panel.html', (error) => {
        if (error) {
            log.warn('Failed to configure side panel for tab:', tabId, error);
            return;
        }
        sidePanelConfiguredTabs.add(tabId);
        callback();
    });
}
function openTabSidePanel(tabId: number): void {
    openPanelSurface(tabId).then(() => {
        sidePanelOpenTabs.add(tabId);
    }).catch((err: unknown) => {
        log.warn('Failed to open side panel for tab:', tabId, err);
    });
}
function closeTabSidePanel(tabId: number): void {
    closePanelSurface(tabId).then(() => {
        sidePanelOpenTabs.delete(tabId);
        if (panelSurfaceKind !== 'sidePanel') {
            sidePanelConfiguredTabs.delete(tabId);
        }
    }).catch((err: unknown) => {
        log.warn('Failed to close side panel for tab:', tabId, err);
    });
}
chrome.action.onClicked.addListener((tab) => {
    if (typeof tab.id !== 'number') return;
    const tabId = tab.id;
    if (panelSurfaceKind === 'sidebarAction') {
        toggleSidebarSurface().catch((err: unknown) => {
            log.warn('Failed to toggle browser sidebar:', err);
        });
        return;
    }
    if (panelSurfaceKind !== 'sidePanel') {
        return;
    }
    if (sidePanelOpenTabs.has(tabId)) {
        closeTabSidePanel(tabId);
        return;
    }
    if (sidePanelConfiguredTabs.has(tabId)) {
        openTabSidePanel(tabId);
        return;
    }
    enableTabSidePanelFromActionClick(tabId, () => openTabSidePanel(tabId));
});
onPanelSurfaceOpened((tabId) => {
    sidePanelConfiguredTabs.add(tabId);
    sidePanelOpenTabs.add(tabId);
});
onPanelSurfaceClosed((tabId) => {
    sidePanelOpenTabs.delete(tabId);
});
// Compile regex patterns for performance
function compileRegexPatterns() {
    compiledRegex = [];
    for (const pattern of blockedRegex) {
        const compiled = compileSafeRegex(pattern, 'i');
        if (compiled.regex) {
            compiledRegex.push({
                pattern: pattern,
                regex: compiled.regex
            });
        }
        else {
            log.warn('Fransyfox: Rejected unsafe or invalid regex pattern:', pattern, compiled.error);
        }
    }
    log.info('Fransyfox: Compiled regex patterns:', compiledRegex.length);
}
// Debounced regex compilation to batch rapid changes
const debouncedCompileRegex = (function () {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    return function () {
        clearTimeout(timeout);
        timeout = setTimeout(compileRegexPatterns, 150);
    };
})();
// Load settings from storage
function loadSettings() {
    chrome.storage.local.get([
        STORAGE_KEYS.DEDUPE_ENABLED,
        STORAGE_KEYS.EXTENSION_ACTIVE,
        STORAGE_KEYS.BLOCKED_LISTENERS,
        STORAGE_KEYS.BLOCKED_URLS,
        STORAGE_KEYS.BLOCKED_REGEX,
        STORAGE_KEYS.MATCH_REPLACE_RULES,
        STORAGE_KEYS.MESSAGE_CONSOLE_LOG_ENABLED,
        STORAGE_KEYS.MESSAGE_DEBUG_BREAK_ENABLED,
        STORAGE_KEYS.MESSAGE_DEBUG_BREAK_MATCH,
        STORAGE_KEYS.MESSAGE_MAX_CAPTURE_SIZE,
        STORAGE_KEYS.PRESERVE_LOG_ENABLED
    ], (result: Record<string, unknown>) => {
        dedupeEnabled = normalizeBoolean(result[STORAGE_KEYS.DEDUPE_ENABLED], true);
        preserveLogEnabled = normalizeBoolean(result[STORAGE_KEYS.PRESERVE_LOG_ENABLED], false);
        extensionActive = normalizeBoolean(result[STORAGE_KEYS.EXTENSION_ACTIVE], true);
        blockedListeners = normalizeStringArray(result[STORAGE_KEYS.BLOCKED_LISTENERS]);
        blockedUrls = normalizeStringArray(result[STORAGE_KEYS.BLOCKED_URLS]);
        blockedRegex = normalizeStringArray(result[STORAGE_KEYS.BLOCKED_REGEX]).slice(0, MAX_USER_REGEX_RULES);
        matchReplaceRules = normalizeMatchReplaceRules(result[STORAGE_KEYS.MATCH_REPLACE_RULES]);
        const debugSettings = normalizeMessageDebugSettings({
            consoleLogEnabled: result[STORAGE_KEYS.MESSAGE_CONSOLE_LOG_ENABLED],
            debugBreakEnabled: result[STORAGE_KEYS.MESSAGE_DEBUG_BREAK_ENABLED],
            debugBreakMatch: result[STORAGE_KEYS.MESSAGE_DEBUG_BREAK_MATCH],
            maxCapturedMessageSize: result[STORAGE_KEYS.MESSAGE_MAX_CAPTURE_SIZE]
        });
        messageConsoleLogEnabled = debugSettings.consoleLogEnabled;
        messageDebugBreakEnabled = debugSettings.debugBreakEnabled;
        messageDebugBreakMatch = debugSettings.debugBreakMatch;
        messageMaxCaptureSize = debugSettings.maxCapturedMessageSize;
        compileRegexPatterns();
        log.info('Fransyfox: Loaded settings - dedupe:', dedupeEnabled, 'active:', extensionActive, 'blocked listeners:', blockedListeners.length, 'blocked URLs:', blockedUrls.length, 'blocked regex:', blockedRegex.length);
        broadcastMessageDebugSettings();
        // Signal that settings are loaded
        settingsLoadedResolve();
    });
}
// Listen for storage changes to keep blocklists updated and refresh badge
chrome.storage.onChanged.addListener((changes: Record<string, chrome.storage.StorageChange>, area: string) => {
    if (area === 'local') {
        if (changes[STORAGE_KEYS.EXTENSION_ACTIVE]) {
            setExtensionActiveState(normalizeBoolean(changes[STORAGE_KEYS.EXTENSION_ACTIVE].newValue, true), { persist: false });
        }
        if (changes[STORAGE_KEYS.BLOCKED_LISTENERS]) {
            blockedListeners = normalizeStringArray(changes[STORAGE_KEYS.BLOCKED_LISTENERS].newValue);
            log.info('Fransyfox: Updated blocked listeners:', blockedListeners.length);
            scheduleRefreshCount(); // Update badge count when blocked listeners change
        }
        if (changes[STORAGE_KEYS.BLOCKED_URLS]) {
            blockedUrls = normalizeStringArray(changes[STORAGE_KEYS.BLOCKED_URLS].newValue);
            log.info('Fransyfox: Updated blocked URLs:', blockedUrls.length);
            scheduleRefreshCount(); // Update badge count when blocked URLs change
        }
        if (changes[STORAGE_KEYS.BLOCKED_REGEX]) {
            blockedRegex = normalizeStringArray(changes[STORAGE_KEYS.BLOCKED_REGEX].newValue).slice(0, MAX_USER_REGEX_RULES);
            debouncedCompileRegex();
            log.info('Fransyfox: Updated blocked regex patterns:', blockedRegex.length);
            scheduleRefreshCount(); // Update badge count when regex patterns change
        }
        if (changes[STORAGE_KEYS.PRESERVE_LOG_ENABLED]) {
            preserveLogEnabled = normalizeBoolean(changes[STORAGE_KEYS.PRESERVE_LOG_ENABLED].newValue, false);
            log.info('Fransyfox: Updated preserve log:', preserveLogEnabled);
        }
        if (changes[STORAGE_KEYS.MATCH_REPLACE_RULES]) {
            matchReplaceRules = normalizeMatchReplaceRules(changes[STORAGE_KEYS.MATCH_REPLACE_RULES].newValue);
            broadcastMatchReplaceRules();
        }
        if (changes[STORAGE_KEYS.MESSAGE_CONSOLE_LOG_ENABLED]
            || changes[STORAGE_KEYS.MESSAGE_DEBUG_BREAK_ENABLED]
            || changes[STORAGE_KEYS.MESSAGE_DEBUG_BREAK_MATCH]
            || changes[STORAGE_KEYS.MESSAGE_MAX_CAPTURE_SIZE]) {
            const debugSettings = normalizeMessageDebugSettings({
                consoleLogEnabled: changes[STORAGE_KEYS.MESSAGE_CONSOLE_LOG_ENABLED]
                    ? changes[STORAGE_KEYS.MESSAGE_CONSOLE_LOG_ENABLED].newValue
                    : messageConsoleLogEnabled,
                debugBreakEnabled: changes[STORAGE_KEYS.MESSAGE_DEBUG_BREAK_ENABLED]
                    ? changes[STORAGE_KEYS.MESSAGE_DEBUG_BREAK_ENABLED].newValue
                    : messageDebugBreakEnabled,
                debugBreakMatch: changes[STORAGE_KEYS.MESSAGE_DEBUG_BREAK_MATCH]
                    ? changes[STORAGE_KEYS.MESSAGE_DEBUG_BREAK_MATCH].newValue
                    : messageDebugBreakMatch,
                maxCapturedMessageSize: changes[STORAGE_KEYS.MESSAGE_MAX_CAPTURE_SIZE]
                    ? changes[STORAGE_KEYS.MESSAGE_MAX_CAPTURE_SIZE].newValue
                    : messageMaxCaptureSize
            });
            messageConsoleLogEnabled = debugSettings.consoleLogEnabled;
            messageDebugBreakEnabled = debugSettings.debugBreakEnabled;
            messageDebugBreakMatch = debugSettings.debugBreakMatch;
            messageMaxCaptureSize = debugSettings.maxCapturedMessageSize;
            broadcastMessageDebugSettings();
        }
    }
});
function broadcastMatchReplaceRules() {
    chrome.tabs.query({}, (tabs) => {
        tabs.forEach((tab) => {
            if (typeof tab.id !== 'number') {
                return;
            }
            chrome.tabs.sendMessage(tab.id, {
                action: 'matchReplaceRulesUpdated',
                rules: matchReplaceRules
            }).catch(() => {
                // Ignore tabs without content scripts
            });
        });
    });
}
function broadcastMessageDebugSettings() {
    const settings: MessageDebugSettings = {
        consoleLogEnabled: messageConsoleLogEnabled,
        debugBreakEnabled: messageDebugBreakEnabled,
        debugBreakMatch: messageDebugBreakMatch,
        maxCapturedMessageSize: messageMaxCaptureSize
    };
    chrome.tabs.query({}, (tabs) => {
        tabs.forEach((tab) => {
            if (typeof tab.id !== 'number') {
                return;
            }
            chrome.tabs.sendMessage(tab.id, {
                action: 'messageDebugSettingsUpdated',
                settings: settings
            }).catch(() => {
                // Ignore tabs without content scripts
            });
        });
    });
}
function broadcastExtensionActiveState() {
    const payload = { action: 'extensionActiveUpdated', active: extensionActive };
    chrome.tabs.query({}, (tabs) => {
        tabs.forEach((tab) => {
            if (typeof tab.id !== 'number') {
                return;
            }
            chrome.tabs.sendMessage(tab.id, payload).catch(() => {
                // Ignore tabs without content scripts
            });
        });
    });
}
function setExtensionActiveState(nextActive: boolean, options: ExtensionActiveOptions = {}): Promise<void> {
    const normalized = nextActive !== false;
    const persist = options.persist !== false;
    const forceSync = options.forceSync === true;
    const changed = extensionActive !== normalized;
    const activateNow = changed && normalized;
    extensionActive = normalized;
    if (!changed && !forceSync) {
        return Promise.resolve();
    }
    if (persist) {
        chrome.storage.local.set({ [STORAGE_KEYS.EXTENSION_ACTIVE]: extensionActive });
    }
    if (changed) {
        log.info('Fransyfox: Extension active state changed:', extensionActive);
    }
    refreshCount();
    scheduleNotifyPanels();
    broadcastExtensionActiveState();
    if (extensionActive) {
        broadcastMatchReplaceRules();
        broadcastMessageDebugSettings();
    }
    const syncPromise = synchronizeContentScripts();
    if (activateNow) {
        void syncPromise.then(() => injectIntoExistingTabs()).catch(() => {
            // Ignore sync failures here, they are already logged.
        });
    }
    return syncPromise;
}
async function registerTrackerContentScripts() {
    if (!chrome.scripting || !chrome.scripting.getRegisteredContentScripts)
        return;
    try {
        const existing = await chrome.scripting.getRegisteredContentScripts();
        const existingIds = new Set((existing || []).map((script) => script.id));
        const missing = DYNAMIC_CONTENT_SCRIPTS.filter((script) => !existingIds.has(script.id));
        if (missing.length > 0) {
            await chrome.scripting.registerContentScripts(missing);
            log.info('Fransyfox: Registered content scripts:', missing.map((script) => script.id));
        }
    }
    catch (error: unknown) {
        if (error instanceof Error && error.message.includes('Duplicate script ID')) {
            return;
        }
        log.error('Fransyfox: Failed to register content scripts:', error);
    }
}
async function unregisterTrackerContentScripts() {
    if (!chrome.scripting || !chrome.scripting.unregisterContentScripts)
        return;
    try {
        await chrome.scripting.unregisterContentScripts({ ids: Object.values(CONTENT_SCRIPT_IDS) });
        log.info('Fransyfox: Unregistered content scripts');
    }
    catch (error) {
        log.error('Fransyfox: Failed to unregister content scripts:', error);
    }
}
async function synchronizeContentScripts() {
    const targetState = extensionActive;
    contentScriptSyncPromise = contentScriptSyncPromise
        .then(async () => {
        if (targetState) {
            await registerTrackerContentScripts();
        }
        else {
            await unregisterTrackerContentScripts();
        }
    })
        .catch((error: unknown) => {
        log.error('Fransyfox: Failed to synchronize content scripts:', error);
    });
    return contentScriptSyncPromise;
}
async function injectIntoExistingTabs() {
    if (!extensionActive || !chrome.scripting || !chrome.tabs)
        return;
    try {
        const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
        for (const tab of tabs) {
            if (!tab || !tab.id)
                continue;
            try {
                await chrome.scripting.executeScript({
                    target: { tabId: tab.id, allFrames: true },
                    files: ['main.js'],
                    world: 'MAIN'
                });
                await chrome.scripting.executeScript({
                    target: { tabId: tab.id, allFrames: true },
                    files: ['shared/constants.js', 'bridge.js'],
                    world: 'ISOLATED'
                });
            }
            catch (error) {
                // Ignore restricted pages (chrome:// etc) and transient frame errors
            }
        }
    }
    catch (error) {
        log.error('Fransyfox: Failed to inject into existing tabs:', error);
    }
}
// Build a STATE message scoped to one tab. The panel owns URL display
// (it tracks its tab via the tabs API), so no chrome.tabs.get here.
function buildStateMessage(tabId: number | null) {
    return {
        type: PORT_MESSAGES.STATE,
        tabId,
        listeners: tabId !== null ? (tab_listeners[tabId] || []) : [],
        extensionActive: extensionActive,
        cached: true,
        timestamp: Date.now(),
        dataVersion: getTabDataVersion(tabId)
    };
}
function getPortTabId(port: chrome.runtime.Port): number | null {
    const mapped = portTabIds.get(port);
    if (typeof mapped === 'number') {
        return mapped;
    }
    return selectedId > 0 ? selectedId : null;
}
// Initialize service worker
async function initializeServiceWorker() {
    // Start loading settings (this will resolve settingsLoadedPromise when done)
    loadSettings();
    // Wait for both persistent state AND settings to be fully loaded
    await initPromise;
    await setExtensionActiveState(extensionActive, { persist: false, forceSync: true });
    if (extensionActive) {
        await injectIntoExistingTabs();
    }
    try {
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tabs.length > 0) {
            selectedId = tabs[0].id || -1;
            if (selectedId > 0) {
                void enableTabSidePanel(selectedId);
            }
            refreshCount();
        }
    }
    catch (error) {
        log.error('Fransyfox: Failed to query active tab:', error);
    }
}
// Trailing throttle for badge refreshes - refreshCount filters every listener
// of the selected tab through the regex blocklist and touches the tabs API,
// so high-frequency call sites must not invoke it directly.
const REFRESH_COUNT_THROTTLE_MS = 250;
let refreshCountTimer: ReturnType<typeof setTimeout> | null = null;
let lastRefreshCountTime = 0;
function scheduleRefreshCount() {
    if (refreshCountTimer) {
        return;
    }
    const delay = Math.max(0, REFRESH_COUNT_THROTTLE_MS - (Date.now() - lastRefreshCountTime));
    refreshCountTimer = setTimeout(() => {
        refreshCountTimer = null;
        lastRefreshCountTime = Date.now();
        void refreshCount();
    }, delay);
}
// FIXED: Count only active (non-blocked) listeners for badge
async function refreshCount() {
    await initPromise;
    if (selectedId > 0 && !extensionActive) {
        try {
            await chrome.tabs.get(selectedId);
            chrome.action.setBadgeText({ text: 'OFF', tabId: selectedId });
            chrome.action.setBadgeBackgroundColor({
                color: [107, 114, 128, 255],
                tabId: selectedId
            });
        }
        catch (error) {
            // Tab no longer exists, ignore
        }
        return;
    }
    // Count only non-blocked listeners
    let activeCount = 0;
    if (tab_listeners[selectedId]) {
        activeCount = tab_listeners[selectedId].filter((listener: ListenerRecord) => !isListenerBlocked(listener)).length;
    }
    if (selectedId > 0) {
        try {
            await chrome.tabs.get(selectedId);
            chrome.action.setBadgeText({ "text": '' + activeCount, tabId: selectedId });
            chrome.action.setBadgeBackgroundColor({
                color: activeCount > 0 ? [255, 0, 0, 255] : [0, 0, 255, 0],
                tabId: selectedId
            });
        }
        catch (error) {
            // Tab no longer exists, clean up
            delete tab_listeners[selectedId];
            delete tab_listener_keys[selectedId];
            delete tab_lasturl[selectedId];
            // Only persist listener data changes
            persistentState.debouncedSave();
        }
    }
}
// Coalesced panel notifications. Listener registrations arrive in bursts
// during page load; a trailing timer turns N changes into one STATE message
// per affected port. Call without a tabId for global changes (e.g. the
// extension active toggle) to notify every port with its own tab's state.
const NOTIFY_PANELS_DELAY_MS = 100;
let notifyPanelsTimer: ReturnType<typeof setTimeout> | null = null;
let notifyAllPanels = false;
const dirtyStateTabs = new Set<number>();
function scheduleNotifyPanels(tabId?: number | null) {
    if (typeof tabId === 'number') {
        dirtyStateTabs.add(tabId);
    }
    else {
        notifyAllPanels = true;
    }
    if (notifyPanelsTimer) {
        return;
    }
    notifyPanelsTimer = setTimeout(() => {
        notifyPanelsTimer = null;
        const all = notifyAllPanels;
        const dirty = new Set(dirtyStateTabs);
        notifyAllPanels = false;
        dirtyStateTabs.clear();
        connectedPorts.forEach((port) => {
            const portTab = getPortTabId(port);
            if (all || (portTab !== null && dirty.has(portTab))) {
                postToPanelPort(port, buildStateMessage(portTab));
            }
        });
    }, NOTIFY_PANELS_DELAY_MS);
}

// ---- Frame graph (per-tab) ------------------------------------------------
// Structure (parent/child + url) comes from chrome.webNavigation. The derived
// listenerCount/maxSeverity per frame is computed when a FRAME_TREE message is
// built, so the structure stays decoupled from listener churn. Node identity
// is the real Chrome frameId, stable within one navigation.
interface FrameStructureNode {
    frameId: number;
    parentFrameId: number;
    url: string;
}
const tabFrameStructures: Record<string, Map<number, FrameStructureNode>> = {};
const frameTreeVersions: Record<string, number> = {};
const SEVERITY_RANK: Record<string, number> = { low: 1, medium: 2, high: 3 };
function bumpFrameTreeVersion(tabId: number | string): void {
    const key = String(tabId);
    frameTreeVersions[key] = (frameTreeVersions[key] || 0) + 1;
}
function getFrameTreeVersion(tabId: number | string | null): number {
    return tabId === null ? 0 : (frameTreeVersions[String(tabId)] || 0);
}
function originFromUrl(url: string | null | undefined): string {
    if (typeof url !== 'string' || !url) return '';
    try {
        return new URL(url).origin;
    }
    catch (error) {
        return '';
    }
}
// Seed a frame node from observed traffic when webNavigation hasn't reported
// it yet. Returns true if the structure changed.
function ensureFrameNode(tabId: number, frameId: number | null | undefined, url?: string | null): boolean {
    if (typeof tabId !== 'number' || typeof frameId !== 'number') return false;
    const key = String(tabId);
    let map = tabFrameStructures[key];
    if (!map) {
        map = new Map<number, FrameStructureNode>();
        tabFrameStructures[key] = map;
    }
    const existing = map.get(frameId);
    if (existing) {
        if (url && !existing.url) {
            existing.url = url;
            return true;
        }
        return false;
    }
    map.set(frameId, { frameId, parentFrameId: -1, url: url || '' });
    return true;
}
async function refreshFrameStructure(tabId: number): Promise<void> {
    if (typeof tabId !== 'number') return;
    let frames: chrome.webNavigation.GetAllFrameResultDetails[] | null;
    try {
        frames = await chrome.webNavigation.getAllFrames({ tabId });
    }
    catch (error) {
        return;
    }
    if (!frames) return;
    const key = String(tabId);
    const map = tabFrameStructures[key] || new Map<number, FrameStructureNode>();
    let changed = false;
    const seen = new Set<number>();
    for (const frame of frames) {
        seen.add(frame.frameId);
        const prev = map.get(frame.frameId);
        const url = frame.url || (prev ? prev.url : '');
        if (!prev || prev.parentFrameId !== frame.parentFrameId || prev.url !== url) {
            map.set(frame.frameId, { frameId: frame.frameId, parentFrameId: frame.parentFrameId, url });
            changed = true;
        }
    }
    // Prune frames webNavigation no longer reports (closed/navigated-away iframes).
    for (const id of Array.from(map.keys())) {
        if (!seen.has(id)) {
            map.delete(id);
            changed = true;
        }
    }
    tabFrameStructures[key] = map;
    if (changed) {
        bumpFrameTreeVersion(tabId);
        scheduleNotifyFrameTree(tabId);
    }
}
function resetFrameStructure(tabId: number): void {
    const key = String(tabId);
    if (tabFrameStructures[key]) {
        delete tabFrameStructures[key];
        bumpFrameTreeVersion(tabId);
        scheduleNotifyFrameTree(tabId);
    }
}
function severityFromFindings(findings: unknown): FrameSeverity {
    if (!Array.isArray(findings)) return null;
    let best: FrameSeverity = null;
    let bestRank = 0;
    for (const finding of findings) {
        const id = finding && typeof finding === 'object' ? (finding as Record<string, unknown>).id : null;
        if (typeof id !== 'string') continue;
        const rule = FransyfoxFindings ? FransyfoxFindings.getRuleById(id) : null;
        const severity = rule && typeof rule.severity === 'string' ? rule.severity : null;
        if (severity && SEVERITY_RANK[severity] > bestRank) {
            bestRank = SEVERITY_RANK[severity];
            best = severity as FrameSeverity;
        }
    }
    return best;
}
function buildFrameTreeMessage(tabId: number | null) {
    const frames: FrameNode[] = [];
    if (tabId !== null) {
        const key = String(tabId);
        const structure = tabFrameStructures[key];
        const counts = new Map<number, number>();
        const sev = new Map<number, FrameSeverity>();
        const listeners = tab_listeners[key] || [];
        for (const listener of listeners) {
            if (!listener || isListenerBlocked(listener)) continue;
            const fid = typeof listener.frameId === 'number' ? listener.frameId : null;
            if (fid === null) continue;
            counts.set(fid, (counts.get(fid) || 0) + 1);
            const severity = severityFromFindings(listener.findings);
            if (severity) {
                const prev = sev.get(fid);
                if (!prev || SEVERITY_RANK[severity] > SEVERITY_RANK[prev]) {
                    sev.set(fid, severity);
                }
            }
        }
        if (structure) {
            for (const node of structure.values()) {
                frames.push({
                    frameId: node.frameId,
                    parentFrameId: node.parentFrameId,
                    url: node.url,
                    origin: originFromUrl(node.url),
                    listenerCount: counts.get(node.frameId) || 0,
                    maxSeverity: sev.get(node.frameId) || null
                });
            }
        }
        // Frames seen only in captured listeners (no webNavigation entry yet).
        for (const [fid, count] of counts) {
            if (!structure || !structure.has(fid)) {
                frames.push({
                    frameId: fid,
                    parentFrameId: -1,
                    url: '',
                    origin: '',
                    listenerCount: count,
                    maxSeverity: sev.get(fid) || null
                });
            }
        }
    }
    return {
        type: PORT_MESSAGES.FRAME_TREE,
        tabId,
        frames,
        version: getFrameTreeVersion(tabId),
        timestamp: Date.now()
    };
}
// Per-tab debounce for structure refreshes. During page load webNavigation
// fires onCommitted/onCompleted for every subframe; coalesce those into one
// getAllFrames() call per tab per window.
const FRAME_REFRESH_DEBOUNCE_MS = 200;
const frameStructureRefreshScheduler = createKeyedTaskScheduler<number>({
    delayMs: FRAME_REFRESH_DEBOUNCE_MS,
    run: refreshFrameStructure,
    onError: (error, tabId) => {
        log.warn('Fransyfox: Failed to refresh frame structure for tab', tabId, error);
    }
});
function scheduleFrameStructureRefresh(tabId: number): void {
    if (typeof tabId !== 'number') return;
    frameStructureRefreshScheduler.schedule(tabId);
}
const NOTIFY_FRAME_TREE_DELAY_MS = 150;
let notifyFrameTreeTimer: ReturnType<typeof setTimeout> | null = null;
const dirtyFrameTreeTabs = new Set<number>();
function scheduleNotifyFrameTree(tabId?: number | null) {
    if (typeof tabId === 'number') {
        dirtyFrameTreeTabs.add(tabId);
    }
    if (notifyFrameTreeTimer) {
        return;
    }
    notifyFrameTreeTimer = setTimeout(() => {
        notifyFrameTreeTimer = null;
        const dirty = new Set(dirtyFrameTreeTabs);
        dirtyFrameTreeTabs.clear();
        connectedPorts.forEach((port) => {
            const portTab = getPortTabId(port);
            if (portTab !== null && dirty.has(portTab)) {
                postToPanelPort(port, buildFrameTreeMessage(portTab));
            }
        });
    }, NOTIFY_FRAME_TREE_DELAY_MS);
}

// Cumulative flood-protection drop counts per tab, surfaced via EVENTS_APPEND
const tabDroppedEvents: Record<string, number> = {};
function noteDroppedEvents(tabId: number | null | undefined, dropped: number) {
    if (typeof tabId !== 'number' || !(dropped > 0)) return;
    tabDroppedEvents[String(tabId)] = (tabDroppedEvents[String(tabId)] || 0) + dropped;
    log.warn('Fransyfox: Flood protection dropped', dropped, 'events for tab', tabId);
}
let pendingEventAppends: Array<Record<string, unknown>> = [];
let pendingEventFromVersion: number | null = null;
let pendingEventVersion = 0;
let pendingEventEvictedCount = 0;
let eventAppendNotifyTimer: ReturnType<typeof setTimeout> | null = null;

function postToPanelPort(port: chrome.runtime.Port, payload: unknown): boolean {
    try {
        port.postMessage(payload);
        return true;
    }
    catch (error) {
        log.info('Fransyfox: Failed to post panel payload:', error);
        removePanelPort(port);
        return false;
    }
}

function asMessageEventRecords(events: Array<Record<string, unknown>>): MessageEventRecord[] {
    return events.filter(shouldExposeStoredEvent);
}

async function buildEventsSnapshot(restored = false) {
    const storedEvents = await eventStore.all();
    return {
        type: PORT_MESSAGES.EVENTS,
        events: asMessageEventRecords(storedEvents),
        timestamp: Date.now(),
        version: eventStore.getVersion(),
        maxEvents: eventStore.getMaxEvents(),
        restored
    };
}

async function postEventsSnapshot(port: chrome.runtime.Port, restored = false): Promise<boolean> {
    return postToPanelPort(port, await buildEventsSnapshot(restored));
}

function resetPendingEventAppends(): void {
    pendingEventAppends = [];
    pendingEventFromVersion = null;
    pendingEventVersion = 0;
    pendingEventEvictedCount = 0;
    if (eventAppendNotifyTimer) {
        clearTimeout(eventAppendNotifyTimer);
        eventAppendNotifyTimer = null;
    }
}

function removePendingEventsForTab(tabId: number | null | undefined): void {
    if (typeof tabId !== 'number') {
        resetPendingEventAppends();
        return;
    }
    pendingEventAppends = pendingEventAppends.filter((event) => event.tabId !== tabId);
    if (pendingEventAppends.length === 0) {
        resetPendingEventAppends();
    }
}

function notifyEventsCleared(
    reason: 'navigation' | 'manual' | 'eviction',
    version: number,
    tabId?: number | null
): void {
    connectedPorts.forEach((port) => {
        postToPanelPort(port, {
            type: PORT_MESSAGES.EVENTS_CLEARED,
            timestamp: Date.now(),
            reason,
            tabId: typeof tabId === 'number' ? tabId : null,
            version
        });
    });
}

async function clearMessageEventsForTab(
    tabId: number | null | undefined,
    reason: 'navigation' | 'manual'
) {
    await initPromise;
    removePendingEventsForTab(tabId);
    if (typeof tabId === 'number') {
        delete tabDroppedEvents[String(tabId)];
    }
    else {
        for (const key of Object.keys(tabDroppedEvents)) {
            delete tabDroppedEvents[key];
        }
    }
    const result =
        typeof tabId === 'number'
            ? await eventStore.clearTab(tabId)
            : await eventStore.clear();
    notifyEventsCleared(reason, result.version, typeof tabId === 'number' ? tabId : null);
    return result;
}

function queueEventAppendNotification(result: EventAppendResult): void {
    if (!result || !result.event) {
        return;
    }
    // Evictions of unsent pending events never reached a panel: remove those
    // appends locally without asking the panel to discard an additional row.
    // Evictions of older events are forwarded as a count so panels can mirror
    // count- and payload-budget retention without a full snapshot.
    for (const evicted of result.evicted || []) {
        const pendingIndex = pendingEventAppends.findIndex((event) => event.id === evicted.id);
        if (pendingIndex >= 0) {
            pendingEventAppends.splice(pendingIndex, 1);
        }
        else {
            pendingEventEvictedCount += 1;
        }
    }
    pendingEventAppends.push(result.event);
    pendingEventFromVersion =
        pendingEventFromVersion === null
            ? result.fromVersion
            : Math.min(pendingEventFromVersion, result.fromVersion);
    pendingEventVersion = Math.max(pendingEventVersion, result.version);

    if (eventAppendNotifyTimer) {
        return;
    }
    eventAppendNotifyTimer = setTimeout(() => {
        eventAppendNotifyTimer = null;
        void flushEventAppendNotifications();
    }, EVENT_APPEND_NOTIFY_DELAY_MS);
}

function flushEventAppendNotifications(): void {
    const events = pendingEventAppends;
    const fromVersion = pendingEventFromVersion;
    const version = pendingEventVersion || eventStore.getVersion();
    const evictedCount = pendingEventEvictedCount;
    pendingEventAppends = [];
    pendingEventFromVersion = null;
    pendingEventVersion = 0;
    pendingEventEvictedCount = 0;

    const exposedEvents = asMessageEventRecords(events);
    if (exposedEvents.length === 0) {
        return;
    }
    connectedPorts.forEach((port) => {
        postToPanelPort(port, {
            type: PORT_MESSAGES.EVENTS_APPEND,
            events: exposedEvents,
            timestamp: Date.now(),
            fromVersion: fromVersion === null ? Math.max(0, version - exposedEvents.length) : fromVersion,
            version,
            maxEvents: eventStore.getMaxEvents(),
            evictedCount: evictedCount > 0 ? evictedCount : undefined,
            droppedByTab: Object.keys(tabDroppedEvents).length > 0 ? Object.assign({}, tabDroppedEvents) : undefined
        });
    });
}

async function recordMessageEvent(
    event: MessageEventRecord & {
        kind?: string;
        channel?: string;
        sourceFrame?: string;
        targetFrame?: string;
        origin?: string | null;
        portsCount?: number;
        dataType?: string;
        dataText?: string;
    },
    sender: chrome.runtime.MessageSender
) {
    if (!event || event.kind !== 'message')
        return;
    if (matchesExtensionBlacklist(
        [
            event.sourceFrame || '',
            event.targetFrame || '',
            event.origin || '',
            capForScan(event.dataText)
        ].join(' ')
    )) {
        return;
    }
    if (hasIgnoredEnvelopeInDataText(event.dataText)) {
        return;
    }
    const tabId = sender && sender.tab ? sender.tab.id : null;
    const pageUrl = sender && sender.tab ? sender.tab.url : null;
    const frameId = sender ? sender.frameId : null;
    const navigationId = typeof tabId === 'number' ? eventStore.getNavigationId(tabId) : null;
    const stored = await eventStore.add({
        // Prefer the bridge's capture timestamp so batching does not skew ts
        ts: typeof event.capturedAt === 'number' && Number.isFinite(event.capturedAt) ? event.capturedAt : undefined,
        kind: event.kind,
        channel: event.channel,
        sourceFrame: event.sourceFrame,
        targetFrame: event.targetFrame,
        origin: event.origin || null,
        portsCount: event.portsCount,
        dataType: event.dataType,
        dataText: event.dataText,
        dataTruncated: event.dataTruncated === true ? true : undefined,
        dataLength: typeof event.dataLength === 'number' ? event.dataLength : undefined,
        tabId: tabId,
        frameId: frameId,
        pageUrl: pageUrl,
        navigationId: navigationId
    });
    if (stored) {
        queueEventAppendNotification(stored);
    }
}
function logListener(data: ListenerRecord) {
    chrome.storage.local.get({ [STORAGE_KEYS.LOG_URL]: '' }, function (items: Record<string, string>) {
        const log_url = items[STORAGE_KEYS.LOG_URL];
        if (!log_url || !log_url.length)
            return;
        try {
            fetch(log_url, {
                method: 'POST',
                headers: { "Content-Type": CONTENT_TYPE_JSON },
                body: JSON.stringify(data)
            }).catch((e: unknown) => {
                log.error('Fransyfox: Failed to log listener:', e);
            });
        }
        catch (e) {
            log.error('Fransyfox: Failed to log listener:', e);
        }
    });
}
// Generate unique key for listener identification
function generateListenerKey(listener: ListenerRecord) {
    const jsUrl = extractJsUrlFromStack(listener.stack, listener.fullstack) || '';
    const hops = listener.hops || '';
    const domain = listener.domain || '';
    const sourceIdentity = getListenerSourceIdentity(listener);
    return `${jsUrl}|${hops}|${domain}|${sourceIdentity}`;
}
function ensureListenerKey(listener: ListenerRecord | null | undefined) {
    if (!listener)
        return '';
    if (listener.listenerKey && typeof listener.listenerKey === 'string') {
        return listener.listenerKey;
    }
    const key = generateListenerKey(listener);
    listener.listenerKey = key;
    return key;
}
function findingsEqual(
    left: Array<{ id?: string; details?: string }> | undefined,
    right: Array<{ id?: string; details?: string }> | undefined
) {
    if (!Array.isArray(left) && !Array.isArray(right))
        return true;
    if (!Array.isArray(left) || !Array.isArray(right))
        return false;
    if (left.length !== right.length)
        return false;
    for (let i = 0; i < left.length; i++) {
        const l = left[i] || {};
        const r = right[i] || {};
        if (l.id !== r.id)
            return false;
        if ((l.details || '') !== (r.details || ''))
            return false;
    }
    return true;
}
function applyFindingsToListener(listener: ListenerRecord) {
    if (!listener || !globalThis.FransyfoxFindings)
        return false;
    const result = FransyfoxFindings.evaluateListener(listener) || { findings: [], errors: [] };
    const findings = result.findings || [];
    const version = FransyfoxFindings.version || 1;
    const existing = listener.findings;
    const existingVersion = listener.findingsVersion;
    const hasFindings = findings.length > 0;
    let changed = false;
    if (existingVersion !== version) {
        changed = true;
    }
    if (!findingsEqual(existing, findings)) {
        changed = true;
    }
    ensureListenerKey(listener);
    if (hasFindings) {
        listener.findings = findings;
    }
    else {
        delete listener.findings;
    }
    listener.findingsVersion = version;
    return changed;
}
function backfillFindingsForAllTabs() {
    if (!globalThis.FransyfoxFindings)
        return false;
    let changed = false;
    for (const listeners of Object.values(tab_listeners)) {
        if (!Array.isArray(listeners))
            continue;
        for (const listener of listeners) {
            ensureListenerKey(listener);
            if (applyFindingsToListener(listener)) {
                changed = true;
            }
        }
    }
    return changed;
}
// Check if listener is duplicate
function isDuplicateListener(newListener: ListenerRecord, tabId: number) {
    if (!dedupeEnabled)
        return false;
    if (!tab_listener_keys[tabId]) {
        tab_listener_keys[tabId] = new Set();
    }
    const key = ensureListenerKey(newListener);
    return tab_listener_keys[tabId].has(key);
}
// Add listener key to tracking
function addListenerKey(listener: ListenerRecord, tabId: number) {
    if (!dedupeEnabled)
        return;
    if (!tab_listener_keys[tabId]) {
        tab_listener_keys[tabId] = new Set();
    }
    const key = ensureListenerKey(listener);
    tab_listener_keys[tabId].add(key);
}
function rebuildListenerKeysForTab(tabId: number | string) {
    const key = String(tabId);
    const listeners = tab_listeners[key] || [];
    const rebuilt = new Set<string>();
    let changed = false;
    for (const listener of listeners) {
        const compactKey = generateListenerKey(listener);
        if (listener.listenerKey !== compactKey) {
            listener.listenerKey = compactKey;
            changed = true;
        }
        // Stale entries belong to previous navigations and must not suppress
        // an equivalent listener registered by the current page.
        if (!listener.stale) {
            rebuilt.add(compactKey);
        }
    }
    tab_listener_keys[key] = rebuilt;
    return changed;
}
function enforceListenerRetention() {
    const changedTabIds = new Set<number>();
    for (const [tabId, listeners] of Object.entries(tab_listeners)) {
        const excess = listeners.length - MAX_LISTENERS_PER_TAB;
        if (excess > 0) {
            const evicted = new Set(listeners
                .slice()
                .sort(compareListenerEvictionPriority)
                .slice(0, excess));
            tab_listeners[tabId] = listeners.filter((listener) => !evicted.has(listener));
            changedTabIds.add(Number(tabId));
        }
    }
    const totalListeners = Object.values(tab_listeners)
        .reduce((sum, listeners) => sum + listeners.length, 0);
    const globalExcess = totalListeners - MAX_LISTENERS_TOTAL;
    if (globalExcess > 0) {
        const candidates: Array<{ tabId: string; listener: ListenerRecord }> = [];
        for (const [tabId, listeners] of Object.entries(tab_listeners)) {
            for (const listener of listeners) {
                candidates.push({ tabId, listener });
            }
        }
        candidates.sort((left, right) => compareListenerEvictionPriority(left.listener, right.listener));
        const evictedByTab = new Map<string, Set<ListenerRecord>>();
        for (const candidate of candidates.slice(0, globalExcess)) {
            let evicted = evictedByTab.get(candidate.tabId);
            if (!evicted) {
                evicted = new Set();
                evictedByTab.set(candidate.tabId, evicted);
            }
            evicted.add(candidate.listener);
        }
        for (const [tabId, evicted] of evictedByTab) {
            tab_listeners[tabId] = tab_listeners[tabId]
                .filter((listener) => !evicted.has(listener));
            changedTabIds.add(Number(tabId));
        }
    }
    for (const tabId of changedTabIds) {
        if (Number.isFinite(tabId)) {
            rebuildListenerKeysForTab(tabId);
        }
    }
    return new Set(Array.from(changedTabIds).filter(Number.isFinite));
}
function normalizeLoadedListenerState() {
    let changed = false;
    const totalListeners = Object.values(tab_listeners)
        .reduce((sum, listeners) => sum + (Array.isArray(listeners) ? listeners.length : 0), 0);
    let fallbackCapturedAt = Date.now() - totalListeners;
    for (const [tabId, listeners] of Object.entries(tab_listeners)) {
        if (!Array.isArray(listeners)) {
            tab_listeners[tabId] = [];
            changed = true;
            continue;
        }
        for (const listener of listeners) {
            if (sanitizeListenerRecord(listener, fallbackCapturedAt++)) {
                changed = true;
            }
        }
    }
    if (enforceListenerRetention().size > 0) {
        changed = true;
    }
    for (const tabId of Object.keys(tab_listeners)) {
        if (rebuildListenerKeysForTab(tabId)) {
            changed = true;
        }
    }
    return changed;
}
// Check if listener matches any regex pattern
function isListenerMatchedByRegex(listener: ListenerRecord) {
    if (!listener.listener || compiledRegex.length === 0) {
        return false;
    }
    for (const compiled of compiledRegex) {
        try {
            if (compiled.regex.test(limitRegexInput(listener.listener))) {
                return true;
            }
        }
        catch (error) {
            log.warn('Fransyfox: Error testing regex pattern:', compiled.pattern, error);
        }
    }
    return false;
}
// Check if listener is blocked (synchronous version) - Enhanced with regex support
function isListenerBlocked(listener: ListenerRecord) {
    // Check if listener code is blocked
    if (blockedListeners.includes(listener.listener)) {
        return true;
    }
    // Check if JS file URL is blocked (with cleaned URL)
    const jsUrl = extractJsUrlFromStack(listener.stack, listener.fullstack);
    if (jsUrl && blockedUrls.includes(jsUrl)) {
        return true;
    }
    // Check if listener matches any regex pattern
    if (isListenerMatchedByRegex(listener)) {
        return true;
    }
    return false;
}
// Add listener with persistence and simple extension filtering
async function addListener(tabId: number, listener: ListenerRecord) {
    await initPromise;
    // Do not trust a page-supplied timestamp to influence retention order.
    listener.capturedAt = Date.now();
    delete listener.listenerKey;
    delete listener.findings;
    delete listener.findingsVersion;
    delete listener.stale;
    delete listener.blocked;
    sanitizeListenerRecord(listener);
    // Simple extension filter - only check for wappalyzer and domlogger
    if (isFromExtension(listener.listener, listener.stack)) {
        log.info('Fransyfox: Ignoring extension listener');
        return { added: false, changedTabIds: [] } satisfies AddListenerResult;
    }
    if (!tab_listeners[tabId]) {
        tab_listeners[tabId] = [];
        tab_listener_keys[tabId] = new Set();
    }
    // A page that just reported a listener is demonstrably loaded. Without
    // this, a cold-started background that receives listenerData before its
    // first tabs.onUpdated 'loading' event treats the page as navigating and
    // wipes the listener it just stored.
    tab_lasturl[tabId] = true;
    if (!isDuplicateListener(listener, tabId)) {
        applyFindingsToListener(listener);
        tab_listeners[tabId].push(listener);
        addListenerKey(listener, tabId);
        const changedTabIds = enforceListenerRetention();
        changedTabIds.add(tabId);
        for (const changedTabId of changedTabIds) {
            bumpTabDataVersion(changedTabId);
        }
        // Save state after modification
        persistentState.debouncedSave();
        if (!isListenerBlocked(listener)) {
            logListener(listener);
        }
        return {
            added: true,
            changedTabIds: Array.from(changedTabIds)
        } satisfies AddListenerResult;
    }
    return { added: false, changedTabIds: [] } satisfies AddListenerResult;
}
// Clear listeners with persistence
async function clearListeners(tabId: number) {
    await initPromise;
    const hadListeners = tab_listeners[tabId] && tab_listeners[tabId].length > 0;
    tab_listeners[tabId] = [];
    if (tab_listener_keys[tabId]) {
        tab_listener_keys[tabId].clear();
    }
    // Increment data version when data actually changes
    if (hadListeners) {
        bumpTabDataVersion(tabId);
    }
    // Save state after modification
    persistentState.debouncedSave();
    return hadListeners;
}
// Mark existing listeners as stale (for preserve log feature)
async function markListenersAsStale(tabId: number) {
    await initPromise;
    const listeners = tab_listeners[tabId];
    if (!listeners || listeners.length === 0) return;
    for (const listener of listeners) {
        listener.stale = true;
    }
    // Clear dedup keys so new listeners from the new page aren't deduped against stale ones
    if (tab_listener_keys[tabId]) {
        tab_listener_keys[tabId].clear();
    }
    bumpTabDataVersion(tabId);
    persistentState.debouncedSave();
}
function isListenerRecord(value: unknown): value is ListenerRecord {
    const record = asRecord(value);
    return !!record && typeof record.listener === 'string';
}
function getListenerPayload(message: Record<string, unknown>): ListenerRecord | null {
    const action = typeof message.action === 'string' ? message.action : null;
    if (action === 'listenerData' && isListenerRecord(message.listener)) {
        return message.listener;
    }
    if (isListenerRecord(message)) {
        return message;
    }
    return null;
}
function isMessageEventRecord(value: unknown): value is MessageEventRecord {
    return !!asRecord(value);
}
function getMessageAction(message: Record<string, unknown>): string | null {
    return typeof message.action === 'string' ? message.action : null;
}
function getBooleanOrFallback(value: unknown, fallback: boolean): boolean {
    return typeof value === 'boolean' ? value : fallback;
}
function getNumberOrNull(value: unknown): number | null {
    return typeof value === 'number' ? value : null;
}
function getStringOrEmpty(value: unknown): string {
    return typeof value === 'string' ? value : '';
}
chrome.runtime.onMessage.addListener(function (msg: unknown, sender: chrome.runtime.MessageSender, sendResponse: (response: unknown) => void) {
    (async () => {
        const safeMsg = parseRuntimeRequestMessage(msg);
        if (!safeMsg) {
            sendResponse({ success: false, error: 'Invalid runtime message' });
            return;
        }
        const safeMsgRecord = safeMsg as Record<string, unknown>;
        const action = getMessageAction(safeMsgRecord);
        if (action === 'requestExtensionActive') {
            await initPromise;
            sendResponse({ active: extensionActive });
            return;
        }
        if (action === 'updateExtensionActive') {
            await initPromise;
            setExtensionActiveState(getBooleanOrFallback(safeMsgRecord.enabled, true));
            sendResponse({ success: true, active: extensionActive });
            return;
        }
        if (action === 'requestPreserveLog') {
            await initPromise;
            sendResponse({ enabled: preserveLogEnabled });
            return;
        }
        if (action === 'updatePreserveLog') {
            await initPromise;
            preserveLogEnabled = getBooleanOrFallback(safeMsgRecord.enabled, false);
            chrome.storage.local.set({ [STORAGE_KEYS.PRESERVE_LOG_ENABLED]: preserveLogEnabled });
            sendResponse({ success: true, enabled: preserveLogEnabled });
            return;
        }
        if (action === 'requestMatchReplaceRules') {
            sendResponse({ rules: matchReplaceRules });
            return;
        }
        if (action === 'requestMessageDebugSettings') {
            sendResponse({
                settings: {
                    consoleLogEnabled: messageConsoleLogEnabled,
                    debugBreakEnabled: messageDebugBreakEnabled,
                    debugBreakMatch: messageDebugBreakMatch,
                    maxCapturedMessageSize: messageMaxCaptureSize
                }
            });
            return;
        }
        // Handle dedupe setting update
        if (action === 'updateDedupeSetting') {
            await initPromise;
            dedupeEnabled = normalizeBoolean(safeMsgRecord.enabled, true);
            // Save to storage
            chrome.storage.local.set({ [STORAGE_KEYS.DEDUPE_ENABLED]: dedupeEnabled });
            if (!dedupeEnabled) {
                for (const tabId in tab_listener_keys) {
                    tab_listener_keys[tabId].clear();
                }
                // Only persist listener data changes
                persistentState.debouncedSave();
            }
            else {
                for (const tabId of Object.keys(tab_listeners)) {
                    rebuildListenerKeysForTab(tabId);
                }
                persistentState.debouncedSave();
            }
            log.info('Fransyfox: Dedupe setting updated to:', dedupeEnabled);
            refreshCount(); // Update badge count when dedupe setting changes
            sendResponse({ success: true });
            return;
        }
        if (action === 'clearFindings') {
            const requestedTabId = getNumberOrNull(safeMsgRecord.tabId);
            const targetTabId = requestedTabId || (sender && sender.tab ? sender.tab.id || null : null);
            if (!targetTabId) {
                sendResponse({ success: false, error: 'Missing tabId' });
                return;
            }
            await initPromise;
            const listeners = tab_listeners[targetTabId] || [];
            let cleared = 0;
            for (const listener of listeners) {
                if (listener && Array.isArray(listener.findings) && listener.findings.length > 0) {
                    cleared += listener.findings.length;
                    delete listener.findings;
                }
                if (listener) {
                    listener.findingsVersion = FransyfoxFindings ? (FransyfoxFindings.version || 1) : 1;
                }
            }
            if (cleared > 0) {
                persistentState.debouncedSave();
                bumpTabDataVersion(targetTabId);
                scheduleNotifyPanels(targetTabId);
            }
            sendResponse({ success: true, cleared });
            return;
        }
        if (action === 'sendPostMessage') {
            const targetTabId = getNumberOrNull(safeMsgRecord.tabId);
            const frameId = getNumberOrNull(safeMsgRecord.frameId);
            if (targetTabId === null) {
                sendResponse({ success: false, error: 'Missing tabId' });
                return;
            }
            await initPromise;
            if (!extensionActive) {
                sendResponse({ success: false, error: 'Extension inactive' });
                return;
            }
            const sendDetail = {
                target: safeMsgRecord.target,
                payload: safeMsgRecord.payload,
                payloadType: safeMsgRecord.payloadType,
                targetOrigin: safeMsgRecord.targetOrigin
            };
            try {
                const options = frameId !== null ? { frameId } : undefined;
                await chrome.tabs.sendMessage(targetTabId, { action: 'composeSend', detail: sendDetail }, options);
                sendResponse({ success: true });
            }
            catch (error) {
                sendResponse({ success: false, error: error instanceof Error ? error.message : 'Send failed' });
            }
            return;
        }
        if (action === 'openInDevtools') {
            const targetTabId = getNumberOrNull(safeMsgRecord.tabId);
            if (!targetTabId) {
                sendResponse({ success: false, error: 'Missing tabId' });
                return;
            }
            try {
                const response = await chrome.runtime.sendMessage({
                    action: 'openResourceInDevtools',
                    tabId: targetTabId,
                    url: safeMsgRecord.url,
                    line: safeMsgRecord.line,
                    column: safeMsgRecord.column
                });
                const success = typeof response === 'object' &&
                    response !== null &&
                    (response as Record<string, unknown>).success === true;
                sendResponse(success ? { success: true } : { success: false });
            }
            catch (error) {
                sendResponse({
                    success: false,
                    error: error instanceof Error ? error.message : 'DevTools unavailable'
                });
            }
            return;
        }
        if (!sender || !sender.tab) {
            sendResponse({ success: false });
            return;
        }
        await initPromise;
        if (!extensionActive) {
            sendResponse({ success: true, inactive: true });
            return;
        }
        const tabId = sender.tab.id;
        if (typeof tabId !== 'number') {
            sendResponse({ success: false, error: 'Invalid tabId' });
            return;
        }
        let changedListenerTabIds: number[] = [];
        const listenerPayload = getListenerPayload(safeMsgRecord);
        if (listenerPayload) {
            if (listenerPayload.listener == 'function () { [native code] }') {
                sendResponse({ success: true });
                return;
            }
            listenerPayload.parent_url = normalizeString(sender.tab.url, '');
            listenerPayload.frameId = typeof sender.frameId === 'number' ? sender.frameId : null;
            listenerPayload.frameUrl = normalizeString(sender.url, '');
            const addResult = await addListener(tabId, listenerPayload);
            changedListenerTabIds = addResult.changedTabIds;
            if (addResult.added) {
                // A new frame may surface via its first listener before
                // webNavigation reports it; seed immediately, but coalesce the
                // expensive getAllFrames() work across listener bursts.
                if (ensureFrameNode(tabId, listenerPayload.frameId, listenerPayload.frameUrl)) {
                    bumpFrameTreeVersion(tabId);
                }
                scheduleNotifyFrameTree(tabId);
                scheduleFrameStructureRefresh(tabId);
            }
        }
        if (safeMsgRecord.eventType === 'postMessage' && isMessageEventRecord(safeMsgRecord.event)) {
            await recordMessageEvent(safeMsgRecord.event, sender);
        }
        if (safeMsgRecord.eventType === 'postMessageBatch' && Array.isArray(safeMsgRecord.events)) {
            const dropped = typeof safeMsgRecord.dropped === 'number' ? safeMsgRecord.dropped : 0;
            noteDroppedEvents(tabId, dropped);
            for (const entry of safeMsgRecord.events) {
                if (isMessageEventRecord(entry)) {
                    // Sequential await preserves event-store id order within the batch
                    await recordMessageEvent(entry, sender);
                }
            }
        }
        if (safeMsgRecord.pushState === true) {
            tab_push[tabId] = true;
            // Don't persist navigation state
        }
        if (safeMsgRecord.changePage === true) {
            delete tab_lasturl[tabId];
            // Don't persist navigation state
        }
        const runtimeLog = getStringOrEmpty(safeMsgRecord.log);
        if (runtimeLog) {
            log.info('Fransyfox Log:', runtimeLog);
        }
        else if (changedListenerTabIds.length > 0) {
            // Badge and panels only change when listener data changed -
            // message events must not trigger badge/tab API work per message.
            scheduleRefreshCount();
            for (const changedTabId of changedListenerTabIds) {
                scheduleNotifyPanels(changedTabId);
                scheduleNotifyFrameTree(changedTabId);
            }
        }
        sendResponse({ success: true });
    })().catch((error: unknown) => {
        log.error('Fransyfox: Message handler error:', error);
        sendResponse({ success: false, error: error instanceof Error ? error.message : 'Unknown error' });
    });
    return true; // Keep message channel open for async response
});
chrome.tabs.onUpdated.addListener(async function (tabId: number, props: { status?: string }) {
    await initPromise;
    if (props.status == "complete") {
        if (tabId == selectedId) {
            refreshCount(); // This now counts only active listeners
        }
        // Frame tree is most complete once the document finishes loading.
        scheduleFrameStructureRefresh(tabId);
    }
    else if (props.status) { // FIXED: Match V2 logic - trigger on ANY status change
        if (tab_push[tabId]) {
            delete tab_push[tabId];
            // Don't persist navigation state
        }
        else {
            if (!tab_lasturl[tabId]) {
                await eventStore.advanceNavigation(tabId);
                // A real navigation invalidates the old frame graph.
                resetFrameStructure(tabId);
                if (preserveLogEnabled) {
                    await markListenersAsStale(tabId);
                    scheduleNotifyPanels(tabId);
                } else {
                    await clearMessageEventsForTab(tabId, 'navigation');
                    const hadListeners = await clearListeners(tabId);
                    if (hadListeners) {
                        scheduleNotifyPanels(tabId);
                    }
                }
            }
        }
    }
    if (props.status == "loading") {
        tab_lasturl[tabId] = true;
        // Don't persist navigation state
    }
});
chrome.tabs.onActivated.addListener(async function (activeInfo: { tabId: number }) {
    await initPromise;
    selectedId = activeInfo.tabId;
    void enableTabSidePanel(activeInfo.tabId);
    refreshCount(); // This now counts only active listeners
    scheduleNotifyPanels(activeInfo.tabId);
    scheduleFrameStructureRefresh(activeInfo.tabId);
});
// Frame graph structure: keep per-tab frame trees in sync with the live DOM.
if (chrome.webNavigation) {
    chrome.webNavigation.onCommitted.addListener((details) => {
        if (typeof details.tabId === 'number') {
            // Top-frame commit means a navigation; subframe commits just add/move frames.
            if (details.frameId === 0) {
                resetFrameStructure(details.tabId);
            }
            scheduleFrameStructureRefresh(details.tabId);
        }
    });
    chrome.webNavigation.onCompleted.addListener((details) => {
        if (typeof details.tabId === 'number') {
            scheduleFrameStructureRefresh(details.tabId);
        }
    });
    chrome.webNavigation.onCreatedNavigationTarget?.addListener((details) => {
        // window.open / target=_blank: refresh the source tab so the opener
        // frame's structure stays current (the opened tab gets its own tree).
        if (typeof details.sourceTabId === 'number') {
            scheduleFrameStructureRefresh(details.sourceTabId);
        }
    });
}
chrome.tabs.onRemoved.addListener(async function (tabId: number) {
    frameStructureRefreshScheduler.cancel(tabId);
    await initPromise;
    delete tab_listeners[tabId];
    delete tab_listener_keys[tabId];
    delete tab_push[tabId];
    delete tab_lasturl[tabId];
    delete tabDataVersions[String(tabId)];
    delete tabFrameStructures[String(tabId)];
    delete frameTreeVersions[String(tabId)];
    sidePanelConfiguredTabs.delete(tabId);
    sidePanelOpenTabs.delete(tabId);
    removePendingEventsForTab(tabId);
    delete tabDroppedEvents[String(tabId)];
    const clearedEvents = await eventStore.removeTab(tabId);
    notifyEventsCleared('navigation', clearedEvents.version, tabId);
    // Only persist listener data changes
    persistentState.debouncedSave();
});
chrome.runtime.onConnect.addListener(function (port: chrome.runtime.Port) {
    registerInitializedPort(port, initPromise, {
        onConnected: () => {
            connectedPorts.push(port);
            // Lightweight hello so the panel's status badge initializes instantly.
            // The panel issues REQUEST_STATE with its tabId immediately, which returns
            // the real per-tab listener data.
            return postToPanelPort(port, {
                type: PORT_MESSAGES.STATE,
                tabId: null,
                listeners: [],
                extensionActive: extensionActive,
                cached: true,
                timestamp: Date.now(),
                dataVersion: 0
            });
        },
        onMessage: async (msg: unknown) => {
            const safeMsg = parsePortRequestMessage(msg);
            if (!safeMsg) return;
            if (safeMsg.type === PORT_MESSAGES.REQUEST_STATE) {
                const requestedTabId = typeof safeMsg.tabId === 'number' ? safeMsg.tabId : null;
                if (requestedTabId !== null) {
                    portTabIds.set(port, requestedTabId);
                }
                return postToPanelPort(port, buildStateMessage(getPortTabId(port)));
            }
            if (safeMsg.type === PORT_MESSAGES.REQUEST_EVENTS) {
                return postEventsSnapshot(port, eventStore.wasHydrated());
            }
            if (safeMsg.type === PORT_MESSAGES.REQUEST_FRAME_TREE) {
                const requestedTabId = typeof safeMsg.tabId === 'number' ? safeMsg.tabId : null;
                if (requestedTabId !== null) {
                    portTabIds.set(port, requestedTabId);
                }
                const targetTabId = getPortTabId(port);
                const delivered = postToPanelPort(port, buildFrameTreeMessage(targetTabId));
                // Kick a structure refresh so the next push reflects live frames.
                if (delivered && typeof targetTabId === 'number') {
                    scheduleFrameStructureRefresh(targetTabId);
                }
                return delivered;
            }
            if (safeMsg.type === PORT_MESSAGES.CLEAR_EVENTS) {
                const targetTabId =
                    typeof safeMsg.tabId === 'number'
                        ? safeMsg.tabId
                        : selectedId > 0
                            ? selectedId
                            : null;
                await clearMessageEventsForTab(targetTabId, 'manual');
                return true;
            }
            if (safeMsg.type === PORT_MESSAGES.CLEAR_LISTENERS) {
                const tabId = typeof safeMsg.tabId === 'number' ? safeMsg.tabId : selectedId;
                if (!Number.isSafeInteger(tabId) || tabId < 0) return true;
                const key = String(tabId);
                tab_listeners[key] = [];
                tab_listener_keys[key] = new Set();
                persistentState.debouncedSave();
                bumpTabDataVersion(key);
                return postToPanelPort(port, {
                    type: PORT_MESSAGES.LISTENERS_CLEARED,
                    timestamp: Date.now()
                });
            }
        },
        onDisconnected: () => {
            removePanelPort(port);
        },
        onError: (error: unknown) => {
            log.warn('Fransyfox: Panel port lifecycle failed:', error);
        }
    });
});
// Initialize
chrome.runtime.onStartup.addListener(initializeServiceWorker);
chrome.runtime.onInstalled.addListener(initializeServiceWorker);
chrome.runtime.onSuspend.addListener(() => {
    // The event store logs persistence failures and keeps its queue recoverable.
    void eventStore.flushNow().catch(() => undefined);
    void persistentState.saveState();
});
// Initialize immediately
initializeServiceWorker();
log.info('Fransyfox: Background script initialized with state persistence and regex support');
