import { parsePortResponseMessage } from './contracts/messages';
import { MAX_USER_REGEX_RULES, compileSafeRegex, limitRegexInput } from './shared/safe-regex';
import type { ListenerRecord, MessageEventRecord, FrameNode } from './types/listener';
import type { MatchReplaceRule } from './types/settings';
// Main panel script for Fransyfox - Optimized with Pre-loading and Port Reconnection Fix
const mainLog = FransyfoxLogger.scoped('panel');

type ViewMode = 'listeners' | 'messages' | 'findings' | 'match' | 'map' | 'timeline';

type PanelMessageEvent = MessageEventRecord & {
    tabId?: number;
    pageUrl?: string;
};
type MessageSortOrder = 'asc' | 'desc';
type MessageEmptyReason = 'none' | 'navigation' | 'manual' | 'eviction' | 'restored';

const COMPOSER_HISTORY_MAX = 50;

interface ComposerEntry {
    frameId: number | null;
    target: string;
    payloadType: 'string' | 'json';
    payload: string;
    targetOrigin: string;
    ts: number;
}

interface MessageDisplayState {
    emptyReason: MessageEmptyReason;
    restored: boolean;
    maxEvents: number;
    droppedCount?: number;
}

interface PanelStorageLike {
    init: () => Promise<void>;
    matchReplaceRules: MatchReplaceRule[];
    matchReplaceRulesText: string;
    messageBeautifyEnabled: boolean;
    prettifyEnabled: boolean;
    messageQuery: string;
    messageTargetFrame: string;
    messageSortOrder: MessageSortOrder;
    messageAllExpanded: boolean;
    panelViewMode: ViewMode;
    parseMatchReplaceText: (text: string) => MatchReplaceRule[];
    saveMatchReplaceRules: (rules: MatchReplaceRule[], text: string) => void;
    saveMessageBeautifySetting: (enabled: boolean) => Promise<void>;
    savePrettifySetting: (enabled: boolean) => Promise<void>;
    grepExtractRegex: string;
    saveGrepExtractRegex: (regex: string) => void;
    savePanelViewMode: (mode: ViewMode) => Promise<void>;
    saveMessageViewSettings: (settings: {
        query?: string;
        targetFrame?: string;
        sortOrder?: MessageSortOrder;
        allExpanded?: boolean;
    }) => Promise<void>;
    extractJsUrlFromStack: (stack?: string, fullstack?: string[]) => string | null;
    isListenerBlocked: (listener: ListenerRecord) => unknown;
}

interface PanelFindingsEntry {
    rule?: Record<string, unknown>;
    finding?: Record<string, unknown>;
    listener?: ListenerRecord;
}

interface PanelUILike {
    currentTabId: number | null;
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
        messages: PanelMessageEvent[],
        currentUrl: string,
        onRefresh: () => void | Promise<void>,
        preserveScroll: boolean,
        state?: MessageDisplayState
    ) => void;
    displayFindings: (
        listeners: ListenerRecord[],
        currentUrl: string,
        preserveScroll: boolean,
        filters: FindingsFilters
    ) => void;
    reHighlightCodeBlocks: (forceRebuild: boolean) => void;
    clearPrettifyCache: () => void;
    updateShowBlockedButton: () => void;
    toggleShowBlocked: () => void;
    toggleAllMessagesExpanded: () => boolean;
    setAllMessagesExpanded: (expanded: boolean) => void;
    areAllMessagesExpanded: () => boolean;
    focusMessage: (messageId: number) => boolean;
    buildFindingsList: (listeners: ListenerRecord[], excludeBlocked?: boolean) => PanelFindingsEntry[];
    applyFindingsFilters: (
        findings: PanelFindingsEntry[],
        filters: FindingsFilters | null
    ) => PanelFindingsEntry[];
}

interface PanelModalsLike {
    setRefreshHandler: (handler: (isManual: boolean) => void | Promise<void>) => void;
    setReHighlightHandler: (handler: (forceRebuild: boolean) => void) => void;
    setClearPrettifyCacheHandler: (handler: () => void) => void;
    init: () => void;
}

interface PanelUIMapLike {
    render: (
        frames: FrameNode[],
        messages: MessageEventRecord[],
        options?: { selectedFrameId?: number | null }
    ) => void;
    setSelectHandler: (handler: (frameId: number | null) => void) => void;
}

interface PanelUITimelineLike {
    render: (frames: FrameNode[], messages: MessageEventRecord[], options?: { highlightId?: number | null }) => void;
    setSelectHandler: (handler: (messageId: number) => void) => void;
}

interface MessageFilters {
    targetFrame: string;
    query: string;
    sortOrder: MessageSortOrder;
}

interface ListenerFilters {
    sortOrder: MessageSortOrder;
    domain: string;
    query: string;
}

interface FindingsFilters {
    query: string;
    severity: string;
    listenerKey: string | null;
}

interface TabLabels {
    listeners: string;
    messages: string;
    findings: string;
    match: string;
    map: string;
    timeline: string;
}

interface DomCache {
    container: HTMLElement | null;
    headerElement: HTMLElement | null;
    countElement: HTMLElement | null;
    statusElement: HTMLElement | null;
    contentElement: HTMLElement | null;
    showBlockedBtn: HTMLButtonElement | null;
    listenersExport: HTMLButtonElement | null;
    messagesBtn: HTMLButtonElement | null;
    messagesDirection: HTMLSelectElement | null;
    messagesFilters: HTMLElement | null;
    messagesTarget: HTMLSelectElement | null;
    messagesSearch: HTMLInputElement | null;
    messagesExport: HTMLButtonElement | null;
    messagesBeautify: HTMLButtonElement | null;
    listenersBeautify: HTMLButtonElement | null;
    messagesExpandAll: HTMLButtonElement | null;
    messagesClear: HTMLButtonElement | null;
    findingsTab: HTMLButtonElement | null;
    findingsFilters: HTMLElement | null;
    findingsSearch: HTMLInputElement | null;
    findingsSeverity: HTMLSelectElement | null;
    findingsExport: HTMLButtonElement | null;
    findingsClear: HTMLButtonElement | null;
    findingsClearFilter: HTMLButtonElement | null;
    listenersTab: HTMLButtonElement | null;
    messagesTab: HTMLButtonElement | null;
    mapTab: HTMLButtonElement | null;
    mapPanel: HTMLElement | null;
    timelineTab: HTMLButtonElement | null;
    timelinePanel: HTMLElement | null;
    listenersToolbar: HTMLElement | null;
    listenerCountElement: HTMLElement | null;
    matchTab: HTMLButtonElement | null;
    utilsPanel: HTMLElement | null;
    utilsSectionMatch: HTMLElement | null;
    utilsSectionMatchHeader: HTMLElement | null;
    utilsSectionGrep: HTMLElement | null;
    utilsSectionGrepHeader: HTMLElement | null;
    matchTextarea: HTMLTextAreaElement | null;
    matchSave: HTMLButtonElement | null;
    matchReload: HTMLButtonElement | null;
    matchSample: HTMLTextAreaElement | null;
    matchPreview: HTMLButtonElement | null;
    matchResult: HTMLElement | null;
    grepRegexInput: HTMLInputElement | null;
    grepExtractBtn: HTMLButtonElement | null;
    grepSortCheckbox: HTMLInputElement | null;
    grepUniqueCheckbox: HTMLInputElement | null;
    grepCopyBtn: HTMLButtonElement | null;
    grepDownloadBtn: HTMLButtonElement | null;
    grepResults: HTMLTextAreaElement | null;
    utilsSectionCompose: HTMLElement | null;
    utilsSectionComposeHeader: HTMLElement | null;
    composeFrame: HTMLSelectElement | null;
    composeTarget: HTMLSelectElement | null;
    composeOrigin: HTMLInputElement | null;
    composePayload: HTMLTextAreaElement | null;
    composeTypeJson: HTMLInputElement | null;
    composeSendBtn: HTMLButtonElement | null;
    composeResult: HTMLElement | null;
    composeHistory: HTMLElement | null;
    composeHistoryClear: HTMLButtonElement | null;
    regexBtn: HTMLButtonElement | null;
    regexModal: HTMLElement | null;
    regexTextarea: HTMLTextAreaElement | null;
    regexSave: HTMLButtonElement | null;
    regexCancel: HTMLButtonElement | null;
    highlightBtn: HTMLButtonElement | null;
    highlightModal: HTMLElement | null;
    highlightTextarea: HTMLTextAreaElement | null;
    highlightSave: HTMLButtonElement | null;
    highlightCancel: HTMLButtonElement | null;
    preserveElement: HTMLElement | null;
    listenersDirection: HTMLSelectElement | null;
    listenersUrlFilter: HTMLSelectElement | null;
    listenersSearch: HTMLInputElement | null;
    listenersClear: HTMLButtonElement | null;
}

function createEmptyDomCache(): DomCache {
    return {
        container: null,
        headerElement: null,
        countElement: null,
        statusElement: null,
        contentElement: null,
        showBlockedBtn: null,
        listenersExport: null,
        messagesBtn: null,
        messagesDirection: null,
        messagesFilters: null,
        messagesTarget: null,
        messagesSearch: null,
        messagesExport: null,
        messagesBeautify: null,
        listenersBeautify: null,
        messagesExpandAll: null,
        messagesClear: null,
        findingsTab: null,
        findingsFilters: null,
        findingsSearch: null,
        findingsSeverity: null,
        findingsExport: null,
        findingsClear: null,
        findingsClearFilter: null,
        listenersTab: null,
        messagesTab: null,
        mapTab: null,
        mapPanel: null,
        timelineTab: null,
        timelinePanel: null,
        listenersToolbar: null,
        listenerCountElement: null,
        matchTab: null,
        utilsPanel: null,
        utilsSectionMatch: null,
        utilsSectionMatchHeader: null,
        utilsSectionGrep: null,
        utilsSectionGrepHeader: null,
        matchTextarea: null,
        matchSave: null,
        matchReload: null,
        matchSample: null,
        matchPreview: null,
        matchResult: null,
        grepRegexInput: null,
        grepExtractBtn: null,
        grepSortCheckbox: null,
        grepUniqueCheckbox: null,
        grepCopyBtn: null,
        grepDownloadBtn: null,
        grepResults: null,
        utilsSectionCompose: null,
        utilsSectionComposeHeader: null,
        composeFrame: null,
        composeTarget: null,
        composeOrigin: null,
        composePayload: null,
        composeTypeJson: null,
        composeSendBtn: null,
        composeResult: null,
        composeHistory: null,
        composeHistoryClear: null,
        regexBtn: null,
        regexModal: null,
        regexTextarea: null,
        regexSave: null,
        regexCancel: null,
        highlightBtn: null,
        highlightModal: null,
        highlightTextarea: null,
        highlightSave: null,
        highlightCancel: null,
        preserveElement: null,
        listenersDirection: null,
        listenersUrlFilter: null,
        listenersSearch: null,
        listenersClear: null
    };
}

class PanelMain {
    storage: PanelStorageLike;
    ui: PanelUILike;
    uiMap: PanelUIMapLike | null;
    uiTimeline: PanelUITimelineLike | null;
    currentFrames: FrameNode[];
    lastFrameTreeVersion: number;
    composerHistory: ComposerEntry[];
    pendingTimelineHighlightId: number | null;
    modals: PanelModalsLike | null;
    port: chrome.runtime.Port | null;
    isPortConnected: boolean;
    currentListeners: ListenerRecord[];
    currentMessages: PanelMessageEvent[];
    currentUrl: string;
    currentTabId: number | null;
    dataLoaded: boolean;
    lastDataVersion: number;
    lastEventsVersion: number;
    viewMode: ViewMode;
    pendingListenerFocusKey: string | null;
    messageFilters: MessageFilters;
    listenerFilters: ListenerFilters;
    findingsFilters: FindingsFilters;
    tabLabels: TabLabels;
    currentMatchRules: MatchReplaceRule[];
    lastListenersByTab: Record<string, ListenerRecord[]>;
    extensionActive: boolean;
    extensionToggleInProgress: boolean;
    preserveLogEnabled: boolean;
    preserveLogToggleInProgress: boolean;
    messageEmptyReason: MessageEmptyReason;
    messageStoreRestored: boolean;
    messageMaxEvents: number;
    messageDroppedByTab: Record<string, number>;
    lastMessagesTargetSignature: string;
    domCache: DomCache;
    updateDebounceTimer: ReturnType<typeof setTimeout> | null;
    updateDebounceDelay: number;
    messageSearchDebounceTimer: ReturnType<typeof setTimeout> | null;
    messageSearchDebounceDelay: number;
    isUpdating: boolean;
    isManualRefresh: boolean;
    pendingRequests: number;
    maxRetries: number;
    messageFilterSaveTimer: ReturnType<typeof setTimeout> | null;
    listenerFilterSaveTimer: ReturnType<typeof setTimeout> | null;
    _lastGrepRawResults: string[];
    _grepRegexSaveTimer: ReturnType<typeof setTimeout> | null;
    _onPortMessage: (msg: unknown) => void;
    _onPortDisconnect: () => void;

    constructor() {
        const PanelStorageCtor = PanelStorage as unknown as { new (): PanelStorageLike };
        const PanelUICtor = PanelUI as unknown as { new (storage: PanelStorageLike): PanelUILike };
        this.storage = new PanelStorageCtor();
        this.ui = new PanelUICtor(this.storage);
        this.ui.setFindingsHandler((listener: ListenerRecord) => this.showFindingsTab(listener));
        this.ui.setListenerFocusHandler((listener: ListenerRecord) => this.showListenerFromFinding(listener));
        // The Map view is rendered by its own module; tolerate it being absent
        // (e.g. if the script failed to load) so the rest of the panel works.
        if (typeof PanelUIMap !== 'undefined') {
            const PanelUIMapCtor = PanelUIMap as unknown as { new (): PanelUIMapLike };
            this.uiMap = new PanelUIMapCtor();
            this.uiMap.setSelectHandler((frameId: number | null) => this.onMapFrameSelected(frameId));
        } else {
            this.uiMap = null;
        }
        if (typeof PanelUITimeline !== 'undefined') {
            const PanelUITimelineCtor = PanelUITimeline as unknown as { new (): PanelUITimelineLike };
            this.uiTimeline = new PanelUITimelineCtor();
            this.uiTimeline.setSelectHandler((messageId: number) => this.onTimelineMessageSelected(messageId));
        } else {
            this.uiTimeline = null;
        }
        this.currentFrames = [];
        this.lastFrameTreeVersion = -1;
        this.composerHistory = [];
        this.pendingTimelineHighlightId = null;
        this.modals = null; // Initialized after DOM cache is ready
        this.port = null;
        this.isPortConnected = false;
        this.currentListeners = [];
        this.currentMessages = [];
        this.currentUrl = '';
        this.currentTabId = null;
        this.dataLoaded = false; // Track if we've received initial data
        this.lastDataVersion = -1; // Track data version from background script
        this.lastEventsVersion = -1;
        this.viewMode = 'listeners';
        this.pendingListenerFocusKey = null;
        this.messageFilters = {
            targetFrame: 'any',
            query: '',
            sortOrder: 'desc'
        };
        this.listenerFilters = {
            sortOrder: 'desc',
            domain: 'any',
            query: ''
        };
        this.findingsFilters = {
            query: '',
            severity: 'any',
            listenerKey: null
        };
        this.tabLabels = {
            listeners: 'Listeners',
            messages: 'Messages',
            findings: 'Findings',
            match: 'Utils',
            map: 'Map',
            timeline: 'Timeline'
        };
        this.currentMatchRules = [];
        this.lastListenersByTab = {};
        this.extensionActive = true;
        this.extensionToggleInProgress = false;
        this.preserveLogEnabled = false;
        this.preserveLogToggleInProgress = false;
        this.messageEmptyReason = 'none';
        this.messageStoreRestored = false;
        this.messageMaxEvents = 5000;
        this.messageDroppedByTab = {};
        this.lastMessagesTargetSignature = '';
        // Cache DOM elements to avoid repeated queries
        this.domCache = createEmptyDomCache();
        // Debounce rapid updates
        this.updateDebounceTimer = null;
        this.updateDebounceDelay = 200; // Coalesce data-driven bursts; manual actions use refreshDisplayNow
        this.messageSearchDebounceTimer = null;
        this.messageSearchDebounceDelay = 250;
        // Track if we're currently updating to prevent cascading updates
        this.isUpdating = false;
        // Track if the last refresh was a manual action (blocking/unblocking)
        this.isManualRefresh = false;
        // Track pending message requests
        this.pendingRequests = 0;
        this.maxRetries = 3;
        this.messageFilterSaveTimer = null;
        this.listenerFilterSaveTimer = null;
        this._lastGrepRawResults = [];
        this._grepRegexSaveTimer = null;
        // Bound listener functions for proper cleanup on reconnect
        this._onPortMessage = (msg: unknown) => {
            mainLog.info("Fransyfox: message received:", msg);
            this.pendingRequests = Math.max(0, this.pendingRequests - 1);
            void this.handleBackgroundMessage(msg);
        };
        this._onPortDisconnect = () => {
            mainLog.info('Fransyfox: Port disconnected');
            this.isPortConnected = false;
            if (chrome.runtime.lastError) {
                mainLog.error('Fransyfox: Port error:', chrome.runtime.lastError);
            }
            // Don't attempt reconnection if panel is being closed
            if (!document.hidden) {
                mainLog.info('Fransyfox: Attempting to reconnect port...');
                setTimeout(() => {
                    try {
                        this.connectPort();
                    } catch (err: unknown) {
                        mainLog.error('Fransyfox: Port reconnection failed:', err);
                    }
                }, 100); // Small delay before reconnection
            }
        };
    }
    // Initialize the panel with DOM caching and immediate data loading
    async init() {
        try {
            // Cache frequently accessed DOM elements early
            this.cacheDOMElements();
            // Clear initial loading state - we'll get real data immediately
            this.clearLoadingState();
            // Setup port communication FIRST for immediate data
            this.connectPort();
            // Load storage settings in parallel
            const storagePromise = this.storage.init();
            // Get initial tab info in parallel
            const tabPromise = this.updateCurrentTab();
            // Setup UI components while data loads
            this.setupEventListeners();
            this.syncFindingsFilterControls();
            this.updateMessageBeautifyButton();
            this.updateListenersBeautifyButton();
            this.updateViewMode();
            this.setupMatchReplacePanel();
            this.setupGrepExtractPanel();
            this.requestExtensionActiveState();
            this.renderStatusBadge();
            this.requestPreserveLogState();
            this.renderPreserveBadge();
            // Initialize modals with handlers
            const PanelModalsCtor = PanelModals as unknown as {
                new (storage: PanelStorageLike, domCache: DomCache): PanelModalsLike;
            };
            this.modals = new PanelModalsCtor(this.storage, this.domCache);
            this.modals.setRefreshHandler(async (isManual: boolean) => {
                if (isManual) {
                    this.isManualRefresh = true;
                }
                await this.requestData();
            });
            this.modals.setReHighlightHandler((forceRebuild: boolean) => {
                this.ui.reHighlightCodeBlocks(forceRebuild);
                this.refreshDisplay(false);
            });
            this.modals.setClearPrettifyCacheHandler(() => {
                this.ui.clearPrettifyCache();
            });
            this.modals.init();
            // Wait for storage and tab info
            await Promise.all([storagePromise, tabPromise]);
            this.viewMode = this.storage.panelViewMode || 'listeners';
            this.updateViewMode();
            this.messageFilters.query = this.storage.messageQuery || '';
            this.messageFilters.targetFrame = this.storage.messageTargetFrame || 'any';
            this.messageFilters.sortOrder = this.storage.messageSortOrder === 'asc' ? 'asc' : 'desc';
            this.ui.setAllMessagesExpanded(!!this.storage.messageAllExpanded);
            this.syncMessageFilterControls();
            this.updateMessagesTargetOptions();
            this.updateMessagesExpandAllButton();
            // Load listener filter settings from storage
            await this.loadListenerFilterSettings();
            if (this.domCache.matchTextarea) {
                this.domCache.matchTextarea.value = this.storage.matchReplaceRulesText || '';
            }
            this.currentMatchRules = this.storage.matchReplaceRules || [];
            void this.loadComposerHistory();
            this.updateTabCounts();
            // If the panel restored directly into a data-driven graph view, fetch its data.
            if (this.viewMode === 'map' || this.viewMode === 'timeline') {
                await Promise.all([this.requestFrameTree(), this.requestEvents()]);
            }
            this.refreshDisplay(false);
            mainLog.info('Fransyfox panel initialized with pre-loading optimization and port reconnection');
        }
        catch (error) {
            mainLog.error('Fransyfox: Panel initialization error:', error);
            this.ui.displayListeners([], 'Error loading', () => { });
        }
    }
    // Connect or reconnect the port with retry logic
    connectPort() {
        try {
            // Remove listeners from old port before disconnecting
            if (this.port) {
                this.port.onMessage.removeListener(this._onPortMessage);
                this.port.onDisconnect.removeListener(this._onPortDisconnect);
                this.port.disconnect();
            }
            this.port = chrome.runtime.connect({
                name: "Fransyfox Communication"
            });
            this.isPortConnected = true;
            this.setupPortCommunication();
            mainLog.info('Fransyfox: Port connected successfully');
            // Request initial data immediately after connection
            void this.requestData();
            void this.requestEvents();
        }
        catch (error) {
            mainLog.error('Fransyfox: Failed to connect port:', error);
            this.isPortConnected = false;
            throw error;
        }
    }
    // Setup port communication with automatic reconnection handling
    setupPortCommunication() {
        if (!this.port)
            return;
        // Add bound listeners (can be removed on reconnect)
        this.port.onMessage.addListener(this._onPortMessage);
        this.port.onDisconnect.addListener(this._onPortDisconnect);
    }
    // Safe method to send messages with automatic reconnection
    async sendMessage(message: unknown, retryCount = 0): Promise<boolean> {
        if (retryCount >= this.maxRetries) {
            mainLog.error('Fransyfox: Max retries reached for message:', message);
            return false;
        }
        try {
            // Check if port is connected
            if (!this.isPortConnected || !this.port) {
                mainLog.info('Fransyfox: Port not connected, attempting to reconnect...');
                this.connectPort();
            }
            const port = this.port;
            if (!port) {
                throw new Error('Port unavailable');
            }
            this.pendingRequests++;
            port.postMessage(message);
            return true;
        }
        catch (error) {
            mainLog.error('Fransyfox: Error sending message, attempt', retryCount + 1, ':', error);
            this.isPortConnected = false;
            // Wait a bit and retry
            await new Promise((resolve) => setTimeout(resolve, 200 * (retryCount + 1)));
            return this.sendMessage(message, retryCount + 1);
        }
    }
    // Request data from background script
    async requestData() {
        const success = await this.sendMessage({
            type: FransyfoxMessages.PORT.REQUEST_STATE,
            tabId: this.currentTabId
        });
        if (!success) {
            mainLog.error('Fransyfox: Failed to request data from background script');
            // Show error state or retry later
        }
    }
    async requestEvents() {
        const success = await this.sendMessage({ type: FransyfoxMessages.PORT.REQUEST_EVENTS });
        if (!success) {
            mainLog.error('Fransyfox: Failed to request events from background script');
        }
    }
    // Correlation: tag each message with the listener count in its receiving
    // frame so the Messages view can show "handled by N listeners".
    annotateHandledBy(messages: PanelMessageEvent[]) {
        if (!messages.length) return;
        const counts = new Map<number, number>();
        for (const frame of this.currentFrames) {
            counts.set(frame.frameId, frame.listenerCount);
        }
        for (const message of messages) {
            const fid = typeof message.frameId === 'number' ? message.frameId : null;
            message.handledByCount = fid !== null ? (counts.get(fid) || 0) : 0;
        }
    }
    async requestFrameTree() {
        const success = await this.sendMessage({
            type: FransyfoxMessages.PORT.REQUEST_FRAME_TREE,
            tabId: this.currentTabId
        });
        if (!success) {
            mainLog.error('Fransyfox: Failed to request frame tree from background script');
        }
    }
    // Fill the composer's frame dropdown from the current frame tree, keeping
    // the user's selection where possible.
    populateComposeFrames() {
        const select = this.domCache.composeFrame;
        if (!select) return;
        const prev = select.value;
        const frames = this.currentFrames.slice().sort((a, b) => a.frameId - b.frameId);
        select.textContent = '';
        if (frames.length === 0) {
            const opt = document.createElement('option');
            opt.value = '';
            opt.textContent = 'No frames detected';
            select.appendChild(opt);
            return;
        }
        for (const frame of frames) {
            const opt = document.createElement('option');
            opt.value = String(frame.frameId);
            const host = frame.origin || frame.url || '';
            let label = frame.frameId === 0 ? 'top' : `frame ${frame.frameId}`;
            if (host) {
                try {
                    label += ` · ${new URL(host).host || host}`;
                } catch {
                    label += ` · ${host}`;
                }
            }
            if (frame.listenerCount > 0) {
                label += ` (${frame.listenerCount} listener${frame.listenerCount === 1 ? '' : 's'})`;
            }
            opt.textContent = label;
            select.appendChild(opt);
        }
        if (prev && frames.some((f) => String(f.frameId) === prev)) {
            select.value = prev;
        }
    }
    async sendComposedMessage() {
        const result = this.domCache.composeResult;
        const setResult = (text: string) => {
            if (result) result.textContent = text;
        };
        if (this.currentTabId === null) {
            setResult('No active tab.');
            return;
        }
        const frameValue = this.domCache.composeFrame ? this.domCache.composeFrame.value : '';
        const frameId = frameValue === '' ? null : Number(frameValue);
        if (frameId === null || !Number.isFinite(frameId)) {
            setResult('Select a target frame first.');
            return;
        }
        const target = this.domCache.composeTarget ? this.domCache.composeTarget.value : 'self';
        const payloadType = this.domCache.composeTypeJson && this.domCache.composeTypeJson.checked ? 'json' : 'string';
        const payload = this.domCache.composePayload ? this.domCache.composePayload.value : '';
        const targetOrigin = this.domCache.composeOrigin ? this.domCache.composeOrigin.value.trim() : '';
        if (payloadType === 'json' && payload.trim()) {
            try {
                JSON.parse(payload);
            } catch {
                setResult('Payload is not valid JSON. Switch to String mode or fix the JSON.');
                return;
            }
        }
        try {
            const response: { success?: boolean; error?: string } | undefined = await new Promise((resolve, reject) => {
                chrome.runtime.sendMessage({
                    action: 'sendPostMessage',
                    tabId: this.currentTabId,
                    frameId,
                    target,
                    payload,
                    payloadType,
                    targetOrigin
                }, (res: { success?: boolean; error?: string } | undefined) => {
                    if (chrome.runtime.lastError) {
                        reject(new Error(chrome.runtime.lastError.message));
                        return;
                    }
                    resolve(res);
                });
            });
            if (response && response.success) {
                setResult(`Sent to frame ${frameId} (${target}).`);
                void this.recordComposerHistory({ frameId, target, payloadType, payload, targetOrigin, ts: Date.now() });
            } else {
                setResult(`Send failed: ${response && response.error ? response.error : 'unknown error'}`);
            }
        } catch (error) {
            setResult(`Send failed: ${error instanceof Error ? error.message : 'unknown error'}`);
        }
    }
    // Load a captured message into the Composer so it can be tweaked & resent.
    async loadComposerFromMessage(detail: { dataText?: string; dataType?: string; frameId?: number | null; origin?: string }) {
        const payload = typeof detail.dataText === 'string' ? detail.dataText : '';
        let payloadType: ComposerEntry['payloadType'] = 'string';
        if (detail.dataType !== 'string') {
            try {
                JSON.parse(payload);
                payloadType = 'json';
            } catch {
                payloadType = 'string';
            }
        }
        await this.openComposer();
        this.applyComposerValues({
            frameId: typeof detail.frameId === 'number' ? detail.frameId : null,
            target: 'self',
            payloadType,
            payload,
            targetOrigin: typeof detail.origin === 'string' ? detail.origin : '',
            ts: Date.now()
        });
        if (this.domCache.composeResult) {
            this.domCache.composeResult.textContent = 'Loaded captured message. Review and Send.';
        }
    }
    // Make the Composer visible and ready (Utils tab, section expanded, frames loaded).
    async openComposer() {
        if (this.viewMode !== 'match') {
            this.viewMode = 'match';
            await this.storage.savePanelViewMode(this.viewMode);
            this.updateViewMode();
        }
        if (this.domCache.utilsSectionCompose) {
            this.domCache.utilsSectionCompose.classList.remove('collapsed');
            this.domCache.utilsSectionCompose.scrollIntoView({ block: 'nearest' });
        }
        await this.requestFrameTree();
        this.populateComposeFrames();
    }
    // Fill the Composer form from a set of values (shared by message-load and history-load).
    applyComposerValues(values: ComposerEntry) {
        if (this.domCache.composeFrame && values.frameId !== null) {
            // The frame may not be in the dropdown yet (frame tree still loading);
            // add a placeholder option so the selection sticks until it refreshes.
            const idStr = String(values.frameId);
            if (!Array.from(this.domCache.composeFrame.options).some((o) => o.value === idStr)) {
                const opt = document.createElement('option');
                opt.value = idStr;
                opt.textContent = `frame ${values.frameId}`;
                this.domCache.composeFrame.appendChild(opt);
            }
            this.domCache.composeFrame.value = idStr;
        }
        if (this.domCache.composeTarget) {
            this.domCache.composeTarget.value = values.target;
        }
        if (this.domCache.composeTypeJson) {
            this.domCache.composeTypeJson.checked = values.payloadType === 'json';
            const stringRadio = document.querySelector<HTMLInputElement>('input[name="compose-type"][value="string"]');
            if (stringRadio) stringRadio.checked = values.payloadType !== 'json';
        }
        if (this.domCache.composePayload) {
            this.domCache.composePayload.value = values.payload;
        }
        if (this.domCache.composeOrigin) {
            this.domCache.composeOrigin.value = values.targetOrigin;
        }
    }
    async loadComposerHistory() {
        try {
            const key = FransyfoxConstants.STORAGE_KEYS.COMPOSER_HISTORY;
            const result: Record<string, unknown> = await new Promise((resolve) => {
                chrome.storage.local.get([key], (res: Record<string, unknown>) => resolve(res || {}));
            });
            const raw = result[key];
            this.composerHistory = Array.isArray(raw) ? (raw as ComposerEntry[]).filter((e) => e && typeof e.payload === 'string') : [];
        } catch {
            this.composerHistory = [];
        }
        this.renderComposerHistory();
    }
    async recordComposerHistory(entry: ComposerEntry) {
        // De-dupe consecutive identical sends; cap the list.
        const last = this.composerHistory[0];
        if (!last || last.payload !== entry.payload || last.frameId !== entry.frameId || last.target !== entry.target) {
            this.composerHistory.unshift(entry);
        } else {
            this.composerHistory[0] = entry;
        }
        if (this.composerHistory.length > COMPOSER_HISTORY_MAX) {
            this.composerHistory = this.composerHistory.slice(0, COMPOSER_HISTORY_MAX);
        }
        this.renderComposerHistory();
        try {
            const key = FransyfoxConstants.STORAGE_KEYS.COMPOSER_HISTORY;
            await new Promise<void>((resolve) => {
                chrome.storage.local.set({ [key]: this.composerHistory }, () => resolve());
            });
        } catch (error) {
            mainLog.warn('Fransyfox: Failed to persist composer history:', error);
        }
    }
    async clearComposerHistory() {
        this.composerHistory = [];
        this.renderComposerHistory();
        try {
            const key = FransyfoxConstants.STORAGE_KEYS.COMPOSER_HISTORY;
            await new Promise<void>((resolve) => {
                chrome.storage.local.set({ [key]: [] }, () => resolve());
            });
        } catch (error) {
            mainLog.warn('Fransyfox: Failed to clear composer history:', error);
        }
    }
    renderComposerHistory() {
        const container = this.domCache.composeHistory;
        if (!container) return;
        container.textContent = '';
        if (this.composerHistory.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'compose-history-empty';
            empty.textContent = 'No sent messages yet.';
            container.appendChild(empty);
            return;
        }
        for (const entry of this.composerHistory) {
            const row = document.createElement('button');
            row.type = 'button';
            row.className = 'compose-history-item';
            const time = new Date(entry.ts || Date.now()).toLocaleTimeString();
            const snippet = entry.payload.length > 48 ? entry.payload.slice(0, 47) + '…' : entry.payload;
            row.textContent = `${time} · frame ${entry.frameId ?? '?'} · ${entry.target} · ${snippet || '(empty)'}`;
            row.title = entry.payload;
            row.addEventListener('click', () => {
                this.applyComposerValues(entry);
                if (this.domCache.composeResult) {
                    this.domCache.composeResult.textContent = 'Loaded from history. Review and Send.';
                }
            });
            container.appendChild(row);
        }
    }
    // Timeline → Messages: clicking a message in the timeline lands on it in
    // the Messages tab (scrolled into view and briefly highlighted).
    onTimelineMessageSelected(messageId: number) {
        void (async () => {
            this.pendingTimelineHighlightId = null;
            this.viewMode = 'messages';
            await this.storage.savePanelViewMode(this.viewMode);
            this.updateViewMode();
            await this.requestEvents();
            this.refreshDisplayNow(false);
            this.focusMessageWhenReady(messageId, 8);
        })();
    }
    // Messages → Timeline: jump to the timeline and highlight a message.
    showMessageInTimeline(messageId: number) {
        void (async () => {
            this.pendingTimelineHighlightId = messageId;
            this.viewMode = 'timeline';
            await this.storage.savePanelViewMode(this.viewMode);
            this.updateViewMode();
            await Promise.all([this.requestFrameTree(), this.requestEvents()]);
            this.refreshDisplayNow(false);
            // Keep the highlight briefly so live event refreshes re-apply it, then clear.
            setTimeout(() => {
                this.pendingTimelineHighlightId = null;
            }, 4000);
        })();
    }
    // Retry focusing a message until the Messages list has rendered it (events
    // may still be loading when navigation is requested).
    focusMessageWhenReady(messageId: number, attempts: number) {
        const ok = this.ui.focusMessage(messageId);
        if (!ok && attempts > 0) {
            setTimeout(() => this.focusMessageWhenReady(messageId, attempts - 1), 120);
        }
    }
    // Clicking a frame node in the Map cross-filters the Messages view to that
    // frame, then switches to it so the user lands on the relevant traffic.
    onMapFrameSelected(frameId: number | null) {
        if (frameId === null) return;
        // Resolve the frame's hop label from an event it received (events carry
        // both the real frameId and the targetFrame hops). The Messages filter
        // is keyed by hops, so this is what cross-filtering needs.
        const match = this.currentMessages.find(
            (m) => typeof m.frameId === 'number' && m.frameId === frameId && typeof m.targetFrame === 'string'
        );
        const target = match && typeof match.targetFrame === 'string' ? match.targetFrame : null;
        if (target) {
            this.messageFilters.targetFrame = target;
            if (this.domCache.messagesTarget) {
                this.domCache.messagesTarget.value = target;
            }
        }
        void (async () => {
            this.viewMode = 'messages';
            await this.storage.savePanelViewMode(this.viewMode);
            this.updateViewMode();
            await this.requestEvents();
            this.refreshDisplayNow(false);
        })();
    }
    requestExtensionActiveState() {
        chrome.runtime.sendMessage({ action: 'requestExtensionActive' }, (response: { active?: boolean } | undefined) => {
            if (chrome.runtime.lastError) {
                mainLog.warn('Fransyfox: Failed to fetch extension active state:', chrome.runtime.lastError.message);
                return;
            }
            if (response && typeof response.active === 'boolean') {
                this.extensionActive = response.active;
                this.renderStatusBadge();
            }
        });
    }
    // Clear the initial loading state
    clearLoadingState() {
        const container = document.getElementById('x');
        if (container) {
            container.innerHTML = ''; // Clear "Scanning for listeners..." immediately
        }
    }
    // Cache DOM elements to avoid repeated queries
    cacheDOMElements() {
        this.domCache.container = document.getElementById('x');
        this.domCache.headerElement = document.getElementById('h');
        this.domCache.countElement = document.getElementById('listener-count');
        this.domCache.statusElement = document.getElementById('status-badge');
        this.domCache.contentElement = document.querySelector<HTMLElement>('.content');
        this.domCache.showBlockedBtn = document.getElementById('show-blocked-btn') as HTMLButtonElement | null;
        this.domCache.listenersExport = document.getElementById('listeners-export') as HTMLButtonElement | null;
        this.domCache.listenersTab = document.getElementById('listeners-tab') as HTMLButtonElement | null;
        this.domCache.messagesTab = document.getElementById('messages-tab') as HTMLButtonElement | null;
        this.domCache.findingsTab = document.getElementById('findings-tab') as HTMLButtonElement | null;
        this.domCache.mapTab = document.getElementById('map-tab') as HTMLButtonElement | null;
        this.domCache.mapPanel = document.getElementById('map-panel');
        this.domCache.timelineTab = document.getElementById('timeline-tab') as HTMLButtonElement | null;
        this.domCache.timelinePanel = document.getElementById('timeline-panel');
        this.domCache.listenersToolbar = document.getElementById('listeners-toolbar');
        this.domCache.messagesFilters = document.getElementById('messages-filters');
        this.domCache.messagesDirection = document.getElementById('messages-direction') as HTMLSelectElement | null;
        this.domCache.messagesTarget = document.getElementById('messages-target') as HTMLSelectElement | null;
        this.domCache.messagesSearch = document.getElementById('messages-search') as HTMLInputElement | null;
        this.domCache.messagesExport = document.getElementById('messages-export') as HTMLButtonElement | null;
        this.domCache.messagesBeautify = document.getElementById('messages-beautify') as HTMLButtonElement | null;
        this.domCache.listenersBeautify = document.getElementById('listeners-beautify') as HTMLButtonElement | null;
        this.domCache.messagesExpandAll = document.getElementById('messages-expand-all') as HTMLButtonElement | null;
        this.domCache.messagesClear = document.getElementById('messages-clear') as HTMLButtonElement | null;
        this.domCache.findingsFilters = document.getElementById('findings-filters');
        this.domCache.findingsSearch = document.getElementById('findings-search') as HTMLInputElement | null;
        this.domCache.findingsSeverity = document.getElementById('findings-severity') as HTMLSelectElement | null;
        this.domCache.findingsExport = document.getElementById('findings-export') as HTMLButtonElement | null;
        this.domCache.findingsClear = document.getElementById('findings-clear') as HTMLButtonElement | null;
        this.domCache.findingsClearFilter = document.getElementById('findings-clear-filter') as HTMLButtonElement | null;
        this.domCache.listenerCountElement = document.getElementById('listener-count');
        this.domCache.matchTab = document.getElementById('utils-tab') as HTMLButtonElement | null;
        this.domCache.utilsPanel = document.getElementById('utils-panel');
        this.domCache.utilsSectionMatch = document.getElementById('utils-section-match');
        this.domCache.utilsSectionMatchHeader = document.getElementById('utils-section-match-header');
        this.domCache.utilsSectionGrep = document.getElementById('utils-section-grep');
        this.domCache.utilsSectionGrepHeader = document.getElementById('utils-section-grep-header');
        this.domCache.matchTextarea = document.getElementById('match-textarea') as HTMLTextAreaElement | null;
        this.domCache.matchSave = document.getElementById('match-save') as HTMLButtonElement | null;
        this.domCache.matchReload = document.getElementById('match-reload') as HTMLButtonElement | null;
        this.domCache.grepRegexInput = document.getElementById('grep-regex-input') as HTMLInputElement | null;
        this.domCache.grepExtractBtn = document.getElementById('grep-extract-btn') as HTMLButtonElement | null;
        this.domCache.grepSortCheckbox = document.getElementById('grep-sort-checkbox') as HTMLInputElement | null;
        this.domCache.grepUniqueCheckbox = document.getElementById('grep-unique-checkbox') as HTMLInputElement | null;
        this.domCache.grepCopyBtn = document.getElementById('grep-copy-btn') as HTMLButtonElement | null;
        this.domCache.grepDownloadBtn = document.getElementById('grep-download-btn') as HTMLButtonElement | null;
        this.domCache.grepResults = document.getElementById('grep-results') as HTMLTextAreaElement | null;
        this.domCache.utilsSectionCompose = document.getElementById('utils-section-compose');
        this.domCache.utilsSectionComposeHeader = document.getElementById('utils-section-compose-header');
        this.domCache.composeFrame = document.getElementById('compose-frame') as HTMLSelectElement | null;
        this.domCache.composeTarget = document.getElementById('compose-target') as HTMLSelectElement | null;
        this.domCache.composeOrigin = document.getElementById('compose-origin') as HTMLInputElement | null;
        this.domCache.composePayload = document.getElementById('compose-payload') as HTMLTextAreaElement | null;
        this.domCache.composeTypeJson = document.getElementById('compose-type-json') as HTMLInputElement | null;
        this.domCache.composeSendBtn = document.getElementById('compose-send-btn') as HTMLButtonElement | null;
        this.domCache.composeResult = document.getElementById('compose-result');
        this.domCache.composeHistory = document.getElementById('compose-history');
        this.domCache.composeHistoryClear = document.getElementById('compose-history-clear') as HTMLButtonElement | null;
        this.domCache.matchSample = document.getElementById('match-sample') as HTMLTextAreaElement | null;
        this.domCache.matchPreview = document.getElementById('match-preview') as HTMLButtonElement | null;
        this.domCache.matchResult = document.getElementById('match-result');
        // Regex modal elements
        this.domCache.regexBtn = document.getElementById('regex-btn') as HTMLButtonElement | null;
        this.domCache.regexModal = document.getElementById('regex-modal');
        this.domCache.regexTextarea = document.getElementById('regex-textarea') as HTMLTextAreaElement | null;
        this.domCache.regexSave = document.getElementById('regex-save') as HTMLButtonElement | null;
        this.domCache.regexCancel = document.getElementById('regex-cancel') as HTMLButtonElement | null;
        // Highlight modal elements
        this.domCache.highlightBtn = document.getElementById('highlight-btn') as HTMLButtonElement | null;
        this.domCache.highlightModal = document.getElementById('highlight-modal');
        this.domCache.highlightTextarea = document.getElementById('highlight-textarea') as HTMLTextAreaElement | null;
        this.domCache.highlightSave = document.getElementById('highlight-save') as HTMLButtonElement | null;
        this.domCache.highlightCancel = document.getElementById('highlight-cancel') as HTMLButtonElement | null;
        // Preserve log badge
        this.domCache.preserveElement = document.getElementById('preserve-badge');
        // Listener filter elements
        this.domCache.listenersDirection = document.getElementById('listeners-direction') as HTMLSelectElement | null;
        this.domCache.listenersUrlFilter = document.getElementById('listeners-url-filter') as HTMLSelectElement | null;
        this.domCache.listenersSearch = document.getElementById('listeners-search') as HTMLInputElement | null;
        this.domCache.listenersClear = document.getElementById('listeners-clear') as HTMLButtonElement | null;
    }
    // Update current tab information
    async updateCurrentTab() {
        try {
            const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
            if (tabs.length > 0) {
                this.currentTabId = typeof tabs[0].id === 'number' ? tabs[0].id : null;
                this.currentUrl = tabs[0].url || 'Unknown URL';
                this.ui.currentTabId = this.currentTabId;
                mainLog.info('Fransyfox: Current tab updated:', this.currentTabId, this.currentUrl);
                this.updateTabCounts();
                if (this.viewMode === 'messages') {
                    this.updateMessagesTargetOptions();
                }
            }
        }
        catch (error) {
            mainLog.error('Fransyfox: Failed to query current tab:', error);
            this.currentTabId = null;
            this.currentUrl = 'Unknown URL';
            this.ui.currentTabId = null;
        }
    }
    // Handle messages from background script - optimized for pre-loaded data
    async handleBackgroundMessage(msg: unknown) {
        const parsedMessage = parsePortResponseMessage(msg);
        if (!parsedMessage) {
            mainLog.warn('Fransyfox: Ignoring empty message');
            return;
        }
        if ('extensionActive' in parsedMessage && typeof parsedMessage.extensionActive === 'boolean') {
            this.extensionActive = parsedMessage.extensionActive;
            this.renderStatusBadge();
        }
        if (parsedMessage.type === FransyfoxMessages.PORT.EVENTS) {
            this.currentMessages = Array.isArray(parsedMessage.events) ? parsedMessage.events : [];
            this.lastEventsVersion =
                typeof parsedMessage.version === 'number' ? parsedMessage.version : this.lastEventsVersion;
            this.messageMaxEvents =
                typeof parsedMessage.maxEvents === 'number' ? parsedMessage.maxEvents : this.messageMaxEvents;
            this.messageStoreRestored = !!parsedMessage.restored;
            if (this.currentMessages.length > 0) {
                this.messageEmptyReason = 'none';
            } else if (parsedMessage.restored) {
                this.messageEmptyReason = 'restored';
            } else if (!['navigation', 'manual', 'eviction'].includes(this.messageEmptyReason)) {
                this.messageEmptyReason = 'none';
            }
            this.updateMessagesTargetOptions();
            this.updateTabCounts();
            if (this.viewMode === 'messages' || this.viewMode === 'timeline') {
                this.refreshDisplay(true);
            }
            return;
        }
        if (parsedMessage.type === FransyfoxMessages.PORT.EVENTS_APPEND) {
            const fromVersion =
                typeof parsedMessage.fromVersion === 'number' ? parsedMessage.fromVersion : null;
            const nextVersion =
                typeof parsedMessage.version === 'number' ? parsedMessage.version : this.lastEventsVersion;
            this.messageMaxEvents =
                typeof parsedMessage.maxEvents === 'number' ? parsedMessage.maxEvents : this.messageMaxEvents;
            if (parsedMessage.droppedByTab && typeof parsedMessage.droppedByTab === 'object') {
                this.messageDroppedByTab = parsedMessage.droppedByTab;
            }
            if (this.lastEventsVersion < 0 || (fromVersion !== null && fromVersion > this.lastEventsVersion)) {
                mainLog.warn('Fransyfox: Event version gap detected, requesting fresh snapshot', {
                    lastEventsVersion: this.lastEventsVersion,
                    fromVersion,
                    nextVersion
                });
                await this.requestEvents();
                return;
            }
            const evictedCount =
                typeof parsedMessage.evictedCount === 'number'
                    ? Math.max(0, Math.floor(parsedMessage.evictedCount))
                    : 0;
            if (evictedCount > 0) {
                this.currentMessages.splice(0, Math.min(evictedCount, this.currentMessages.length));
            }
            this.mergeMessageEvents(
                Array.isArray(parsedMessage.events) ? parsedMessage.events : [],
                this.messageMaxEvents
            );
            this.lastEventsVersion = Math.max(this.lastEventsVersion, nextVersion);
            this.messageStoreRestored = false;
            if (this.currentMessages.length > 0) {
                this.messageEmptyReason = 'none';
            }
            this.updateMessagesTargetOptions();
            this.updateTabCounts();
            if (this.viewMode === 'messages' || this.viewMode === 'timeline') {
                this.refreshDisplay(true);
            }
            return;
        }
        if (parsedMessage.type === FransyfoxMessages.PORT.EVENTS_CLEARED) {
            const clearedTabId = typeof parsedMessage.tabId === 'number' ? parsedMessage.tabId : null;
            const affectsCurrentTab = clearedTabId === null || clearedTabId === this.currentTabId;
            if (clearedTabId !== null) {
                this.currentMessages = this.currentMessages.filter((message) => message.tabId !== clearedTabId);
                delete this.messageDroppedByTab[String(clearedTabId)];
            } else {
                this.currentMessages = [];
                this.messageDroppedByTab = {};
            }
            this.lastEventsVersion =
                typeof parsedMessage.version === 'number' ? parsedMessage.version : this.lastEventsVersion;
            this.messageStoreRestored = false;
            if (affectsCurrentTab) {
                this.messageEmptyReason = parsedMessage.reason || 'manual';
            }
            this.updateTabCounts();
            if (this.viewMode === 'messages' || this.viewMode === 'timeline') {
                this.refreshDisplay(false);
            }
            if (parsedMessage.reason === 'eviction') {
                await this.requestEvents();
            }
            return;
        }
        if (parsedMessage.type === FransyfoxMessages.PORT.LISTENERS_CLEARED) {
            this.currentListeners = [];
            if (this.currentTabId !== null) {
                this.lastListenersByTab[this.currentTabId] = [];
            }
            this.updateTabCounts();
            if (this.viewMode === 'listeners') {
                this.refreshDisplay(false);
            }
            return;
        }
        if (parsedMessage.type === FransyfoxMessages.PORT.FRAME_TREE) {
            const frameTabId = typeof parsedMessage.tabId === 'number' ? parsedMessage.tabId : null;
            // Ignore frame trees for other tabs (the hello/global case has no tab).
            if (frameTabId === null || (this.currentTabId !== null && frameTabId !== this.currentTabId)) {
                return;
            }
            const version = typeof parsedMessage.version === 'number' ? parsedMessage.version : 0;
            this.currentFrames = Array.isArray(parsedMessage.frames) ? parsedMessage.frames : [];
            this.lastFrameTreeVersion = version;
            // Messages view consumes frames for the correlation badge.
            if (this.viewMode === 'map' || this.viewMode === 'timeline' || this.viewMode === 'messages') {
                this.refreshDisplay(false);
            }
            // Keep the composer's frame dropdown current when Utils is open.
            if (this.domCache.utilsSectionCompose && !this.domCache.utilsSectionCompose.classList.contains('collapsed')) {
                this.populateComposeFrames();
            }
            return;
        }
        if (parsedMessage.type !== FransyfoxMessages.PORT.STATE) {
            mainLog.warn('Fransyfox: Ignoring unexpected message:', parsedMessage);
            return;
        }
        // STATE is now scoped to a single tab. The background's hello message
        // carries tabId null with an empty list - skip it for listener data.
        const messageTabId = typeof parsedMessage.tabId === 'number' ? parsedMessage.tabId : null;
        if (messageTabId === null) {
            return;
        }
        const stateListeners = Array.isArray(parsedMessage.listeners) ? parsedMessage.listeners : [];
        // Cache per tab so switching tabs shows data instantly without a flash
        this.lastListenersByTab[messageTabId] = stateListeners;
        // Update current tab info if we don't have it
        if (!this.currentTabId) {
            await this.updateCurrentTab();
        }
        // Ignore updates for tabs other than the one this panel is showing
        if (this.currentTabId !== null && messageTabId !== this.currentTabId) {
            return;
        }
        if (this.currentTabId !== null) {
            const newListeners = stateListeners;
            // For the first load or manual refreshes, always update
            // For subsequent automatic updates, only update if data version changed
            // Using dataVersion is much faster than JSON.stringify comparison
            const dataVersion = parsedMessage.dataVersion !== undefined ? parsedMessage.dataVersion : -1;
            const dataChanged = dataVersion !== this.lastDataVersion;
            const isFirstLoad = !this.dataLoaded;
            // Update tracked version
            this.lastDataVersion = dataVersion;
            if (isFirstLoad || this.isManualRefresh || dataChanged) {
                if (isFirstLoad) {
                    mainLog.info(`Fransyfox: Initial data loaded for tab ${this.currentTabId}:`, `${newListeners.length} listeners`, parsedMessage.cached ? '(cached)' : '(fresh)');
                    this.dataLoaded = true;
                }
                else if (dataChanged) {
                    mainLog.info(`Fransyfox: Listeners updated for tab ${this.currentTabId}:`, `${this.currentListeners.length} -> ${newListeners.length}`);
                }
                else {
                    mainLog.info('Fransyfox: Manual refresh triggered (blocking/unblocking action)');
                }
                this.currentListeners = newListeners;
                this.updateListenersUrlOptions();
                this.updateTabCounts();
                // For first load, don't preserve scroll. For updates, preserve unless manual
                const preserveScroll = this.dataLoaded && !this.isManualRefresh;
                this.refreshDisplay(preserveScroll);
                // Reset the manual refresh flag
                this.isManualRefresh = false;
            }
        }
        else {
            // Fallback: show empty state
            mainLog.warn('Fransyfox: No current tab ID available');
            this.currentListeners = [];
            this.refreshDisplay(!this.isManualRefresh);
            this.isManualRefresh = false;
            this.dataLoaded = true;
        }
    }
    // Render the active view immediately (no debounce). Shared by the
    // debounced and immediate refresh paths.
    runDisplay(preserveScroll = false) {
        this.isUpdating = true;
        if (this.viewMode === 'messages') {
            const filtered = this.getFilteredMessages();
            this.annotateHandledBy(filtered);
            this.ui.displayMessages(filtered, this.currentUrl, async () => {
                await this.requestEvents();
            }, preserveScroll, {
                emptyReason: this.messageEmptyReason,
                restored: this.messageStoreRestored,
                maxEvents: this.messageMaxEvents,
                droppedCount: this.currentTabId !== null
                    ? (this.messageDroppedByTab[String(this.currentTabId)] || 0)
                    : 0
            });
        }
        else if (this.viewMode === 'findings') {
            this.ui.displayFindings(this.currentListeners, this.currentUrl, preserveScroll, this.findingsFilters);
        }
        else if (this.viewMode === 'map') {
            if (this.uiMap) {
                this.uiMap.render(this.currentFrames, this.currentMessages, {
                    selectedFrameId: null
                });
            }
        }
        else if (this.viewMode === 'timeline') {
            if (this.uiTimeline) {
                // The timeline honors the Messages filters for a consistent view.
                this.uiTimeline.render(this.currentFrames, this.getFilteredMessages(), {
                    highlightId: this.pendingTimelineHighlightId
                });
            }
        }
        else if (this.viewMode === 'match') {
            // Utils panel is static HTML; nothing to render here.
        }
        else {
            const focusKey = this.pendingListenerFocusKey;
            this.pendingListenerFocusKey = null;
            const filtered = this.getFilteredListeners();
            const reverseNumbering = this.listenerFilters.sortOrder === 'desc';
            this.ui.displayListeners(filtered, this.currentUrl, async () => {
                // Mark this as a manual refresh when onRefresh is called
                this.isManualRefresh = true;
                // Request fresh data from background, which will trigger badge update
                await this.requestData();
            }, preserveScroll, (listener: ListenerRecord) => this.showFindingsTab(listener), focusKey, reverseNumbering);
        }
        requestAnimationFrame(() => this.renderStatusBadge());
        this.isUpdating = false;
    }
    // Render immediately, bypassing the debounce. For user-driven actions
    // (tab clicks, filter changes, block/unblock) where latency is visible.
    refreshDisplayNow(preserveScroll = false) {
        if (this.updateDebounceTimer) {
            clearTimeout(this.updateDebounceTimer);
            this.updateDebounceTimer = null;
        }
        this.runDisplay(preserveScroll);
    }
    // Debounced refresh to coalesce bursts of data-driven updates
    refreshDisplay(preserveScroll = false) {
        // Prevent cascading updates
        if (this.isUpdating) {
            return;
        }
        // Clear existing timer
        if (this.updateDebounceTimer) {
            clearTimeout(this.updateDebounceTimer);
        }
        this.updateDebounceTimer = setTimeout(() => {
            this.updateDebounceTimer = null;
            this.runDisplay(preserveScroll);
        }, this.updateDebounceDelay);
    }
    // Setup main event listeners with cached DOM elements
    setupEventListeners() {
        if (this.domCache.statusElement) {
            this.domCache.statusElement.addEventListener('click', () => {
                void this.toggleExtensionActive();
            });
        }
        if (this.domCache.preserveElement) {
            this.domCache.preserveElement.addEventListener('click', () => {
                void this.togglePreserveLog();
            });
        }
        if (this.domCache.listenersTab) {
            this.domCache.listenersTab.addEventListener('click', () => {
                void (async () => {
                    if (this.viewMode === 'listeners')
                        return;
                    this.viewMode = 'listeners';
                    await this.storage.savePanelViewMode(this.viewMode);
                    this.updateViewMode();
                    await this.requestData();
                    this.refreshDisplayNow(false);
                })();
            });
        }
        if (this.domCache.messagesTab) {
            this.domCache.messagesTab.addEventListener('click', () => {
                void (async () => {
                    if (this.viewMode === 'messages')
                        return;
                    this.viewMode = 'messages';
                    await this.storage.savePanelViewMode(this.viewMode);
                    this.updateViewMode();
                    // Frame tree powers the "handled by N listeners" correlation badge.
                    await Promise.all([this.requestEvents(), this.requestFrameTree()]);
                    this.refreshDisplayNow(false);
                })();
            });
        }
        if (this.domCache.findingsTab) {
            this.domCache.findingsTab.addEventListener('click', () => {
                void (async () => {
                    if (this.viewMode === 'findings')
                        return;
                    this.viewMode = 'findings';
                    await this.storage.savePanelViewMode(this.viewMode);
                    this.updateViewMode();
                    this.refreshDisplayNow(false);
                })();
            });
        }
        if (this.domCache.matchTab) {
            this.domCache.matchTab.addEventListener('click', () => {
                void (async () => {
                    if (this.viewMode === 'match')
                        return;
                    this.viewMode = 'match';
                    await this.storage.savePanelViewMode(this.viewMode);
                    this.updateViewMode();
                    this.refreshDisplayNow(false);
                })();
            });
        }
        if (this.domCache.mapTab) {
            this.domCache.mapTab.addEventListener('click', () => {
                void (async () => {
                    if (this.viewMode === 'map')
                        return;
                    this.viewMode = 'map';
                    await this.storage.savePanelViewMode(this.viewMode);
                    this.updateViewMode();
                    // The Map needs both the frame tree and message events.
                    await Promise.all([this.requestFrameTree(), this.requestEvents()]);
                    this.refreshDisplayNow(false);
                })();
            });
        }
        if (this.domCache.timelineTab) {
            this.domCache.timelineTab.addEventListener('click', () => {
                void (async () => {
                    if (this.viewMode === 'timeline')
                        return;
                    this.viewMode = 'timeline';
                    await this.storage.savePanelViewMode(this.viewMode);
                    this.updateViewMode();
                    await Promise.all([this.requestFrameTree(), this.requestEvents()]);
                    this.refreshDisplayNow(false);
                })();
            });
        }
        // Utils section collapse/expand
        if (this.domCache.utilsSectionMatchHeader) {
            this.domCache.utilsSectionMatchHeader.addEventListener('click', (e: MouseEvent) => {
                if ((e.target as HTMLElement).tagName === 'BUTTON') return;
                this.domCache.utilsSectionMatch?.classList.toggle('collapsed');
            });
        }
        if (this.domCache.utilsSectionGrepHeader) {
            this.domCache.utilsSectionGrepHeader.addEventListener('click', (e: MouseEvent) => {
                if ((e.target as HTMLElement).tagName === 'BUTTON') return;
                this.domCache.utilsSectionGrep?.classList.toggle('collapsed');
            });
        }
        if (this.domCache.utilsSectionComposeHeader) {
            this.domCache.utilsSectionComposeHeader.addEventListener('click', (e: MouseEvent) => {
                if ((e.target as HTMLElement).tagName === 'BUTTON') return;
                const section = this.domCache.utilsSectionCompose;
                const willExpand = !!section && section.classList.contains('collapsed');
                section?.classList.toggle('collapsed');
                // Populate the frame list when the section is opened.
                if (willExpand) {
                    void this.requestFrameTree();
                    this.populateComposeFrames();
                }
            });
        }
        if (this.domCache.composeSendBtn) {
            this.domCache.composeSendBtn.addEventListener('click', () => {
                void this.sendComposedMessage();
            });
        }
        // "Send to Repeater" from a captured message row loads it into the Composer.
        document.addEventListener('fransyfox:repeater-load', (event: Event) => {
            const detail = (event as CustomEvent).detail as {
                dataText?: string;
                dataType?: string;
                frameId?: number | null;
                origin?: string;
            } | null;
            if (detail) {
                void this.loadComposerFromMessage(detail);
            }
        });
        // "Show in timeline" from a captured message row jumps to the timeline.
        document.addEventListener('fransyfox:show-in-timeline', (event: Event) => {
            const detail = (event as CustomEvent).detail as { id?: number } | null;
            if (detail && typeof detail.id === 'number') {
                this.showMessageInTimeline(detail.id);
            }
        });
        if (this.domCache.composeHistoryClear) {
            this.domCache.composeHistoryClear.addEventListener('click', () => {
                void this.clearComposerHistory();
            });
        }
        // Show blocked toggle
        if (this.domCache.showBlockedBtn) {
            this.domCache.showBlockedBtn.addEventListener('click', () => {
                this.ui.toggleShowBlocked();
                // Don't preserve scroll for manual actions
                this.refreshDisplayNow(false);
            });
        }
        if (this.domCache.listenersExport) {
            this.domCache.listenersExport.addEventListener('click', () => {
                this.exportListeners();
            });
        }
        if (this.domCache.listenersDirection) {
            const listenersDirection = this.domCache.listenersDirection;
            listenersDirection.addEventListener('change', () => {
                this.listenerFilters.sortOrder = listenersDirection.value === 'asc' ? 'asc' : 'desc';
                this.persistListenerFilterSettings();
                this.refreshDisplayNow(true);
            });
        }
        if (this.domCache.listenersUrlFilter) {
            const listenersUrlFilter = this.domCache.listenersUrlFilter;
            listenersUrlFilter.addEventListener('change', () => {
                this.listenerFilters.domain = listenersUrlFilter.value;
                this.persistListenerFilterSettings();
                this.refreshDisplayNow(true);
            });
        }
        if (this.domCache.listenersSearch) {
            const listenersSearch = this.domCache.listenersSearch;
            listenersSearch.addEventListener('input', () => {
                this.listenerFilters.query = listenersSearch.value;
                this.scheduleListenerFilterSettingsSave();
                this.refreshDisplay(true);
            });
        }
        if (this.domCache.listenersClear) {
            this.domCache.listenersClear.addEventListener('click', () => {
                void this.sendMessage({ type: FransyfoxMessages.PORT.CLEAR_LISTENERS, tabId: this.currentTabId });
            });
        }
        this.ui.updateShowBlockedButton();
        // Listen for tab changes to update display
        // Side panel persists across tab switches, so we must re-request data.
        // Update currentTabId synchronously from activeInfo to avoid race conditions
        // where background notifications arrive before async updateCurrentTab() resolves.
        if (chrome.tabs && chrome.tabs.onActivated) {
            chrome.tabs.onActivated.addListener((activeInfo: { tabId: number }) => {
                void (async () => {
                    mainLog.info('Fransyfox: Tab activated:', activeInfo.tabId);
                    // Set tab ID immediately to avoid stale filtering of incoming messages
                    this.currentTabId = activeInfo.tabId;
                    this.ui.currentTabId = activeInfo.tabId;
                    // Show last-known data for this tab immediately so listeners display without waiting
                    this.currentListeners = this.lastListenersByTab[activeInfo.tabId] || [];
                    this.updateTabCounts();
                    this.refreshDisplay(false);
                    // Force accepting the next update by resetting version tracking
                    this.lastDataVersion = -1;
                    // Fetch full tab info (URL etc.) and re-request fresh data
                    await this.updateCurrentTab();
                    await this.requestData();
                    await this.requestEvents();
                })();
            });
        }
        // Listen for tab removal — if the closed tab was our current tab,
        // the side panel must switch to whatever tab is now active.
        // This handles cases where onActivated may not fire (or fires late)
        // after a tab close.
        if (chrome.tabs && chrome.tabs.onRemoved) {
            chrome.tabs.onRemoved.addListener((removedTabId: number) => {
                void (async () => {
                    if (removedTabId === this.currentTabId) {
                        mainLog.info('Fransyfox: Current tab closed, switching to active tab');
                        this.currentTabId = null;
                        this.currentListeners = [];
                        this.lastDataVersion = -1;
                        await this.updateCurrentTab();
                        // Show last-known data for the new active tab
                        if (this.currentTabId !== null) {
                            this.currentListeners = this.lastListenersByTab[this.currentTabId] || [];
                        }
                        this.updateTabCounts();
                        this.refreshDisplay(false);
                        await this.requestData();
                        await this.requestEvents();
                    }
                })();
            });
        }
        // Listen for tab updates to refresh URL display
        if (chrome.tabs && chrome.tabs.onUpdated) {
            chrome.tabs.onUpdated.addListener((tabId: number, changeInfo: { url?: string }) => {
                if (tabId === this.currentTabId && changeInfo.url) {
                    mainLog.info('Fransyfox: Tab URL changed:', changeInfo.url);
                    this.currentUrl = changeInfo.url;
                    this.refreshDisplay(false);
                }
            });
        }
        if (this.domCache.messagesTarget) {
            const messagesTarget = this.domCache.messagesTarget;
            messagesTarget.addEventListener('change', () => {
                this.flushPendingMessageSearch(true);
                this.messageFilters.targetFrame = messagesTarget.value;
                void this.persistMessageFilterSettings();
                this.refreshDisplay(true);
            });
        }
        if (this.domCache.messagesSearch) {
            const messagesSearch = this.domCache.messagesSearch;
            messagesSearch.addEventListener('input', () => {
                this.scheduleMessageSearch();
            });
        }
        if (this.domCache.messagesDirection) {
            const messagesDirection = this.domCache.messagesDirection;
            messagesDirection.addEventListener('change', () => {
                this.flushPendingMessageSearch(true);
                this.messageFilters.sortOrder = messagesDirection.value === 'asc' ? 'asc' : 'desc';
                void this.persistMessageFilterSettings();
                this.refreshDisplay(true);
            });
        }
        if (this.domCache.messagesBeautify) {
            this.domCache.messagesBeautify.addEventListener('click', () => {
                void (async () => {
                    await this.storage.saveMessageBeautifySetting(!this.storage.messageBeautifyEnabled);
                    this.updateMessageBeautifyButton();
                    this.refreshDisplay(true);
                })();
            });
        }
        if (this.domCache.listenersBeautify) {
            this.domCache.listenersBeautify.addEventListener('click', () => {
                void (async () => {
                    await this.storage.savePrettifySetting(!this.storage.prettifyEnabled);
                    this.updateListenersBeautifyButton();
                    this.ui.clearPrettifyCache();
                    this.refreshDisplay(true);
                })();
            });
        }
        if (this.domCache.messagesExpandAll) {
            this.domCache.messagesExpandAll.addEventListener('click', () => {
                const allExpanded = this.ui.toggleAllMessagesExpanded();
                this.storage.saveMessageViewSettings({ allExpanded }).catch((error: unknown) => {
                    mainLog.error('Fransyfox: Failed to save expand/collapse-all setting:', error);
                });
                this.updateMessagesExpandAllButton();
                this.refreshDisplay(true);
            });
        }
        if (this.domCache.messagesExport) {
            this.domCache.messagesExport.addEventListener('click', () => {
                this.flushPendingMessageSearch(true);
                this.exportMessages();
            });
        }
        if (this.domCache.messagesClear) {
            this.domCache.messagesClear.addEventListener('click', () => {
                void this.sendMessage({
                    type: FransyfoxMessages.PORT.CLEAR_EVENTS,
                    tabId: this.currentTabId
                });
            });
        }
        if (this.domCache.findingsSearch) {
            const findingsSearch = this.domCache.findingsSearch;
            findingsSearch.addEventListener('input', () => {
                this.findingsFilters.query = findingsSearch.value.trim().toLowerCase();
                this.refreshDisplay(true);
            });
        }
        if (this.domCache.findingsSeverity) {
            const findingsSeverity = this.domCache.findingsSeverity;
            findingsSeverity.addEventListener('change', () => {
                this.findingsFilters.severity = findingsSeverity.value || 'any';
                this.refreshDisplay(true);
            });
        }
        if (this.domCache.findingsClearFilter) {
            this.domCache.findingsClearFilter.addEventListener('click', () => {
                this.resetFindingsFilters();
                this.refreshDisplay(false);
            });
        }
        if (this.domCache.findingsExport) {
            this.domCache.findingsExport.addEventListener('click', () => {
                this.exportFindings();
            });
        }
        if (this.domCache.findingsClear) {
            this.domCache.findingsClear.addEventListener('click', () => {
                this.clearFindings();
            });
        }
    }
    setupMatchReplacePanel() {
        if (this.domCache.matchTextarea) {
            this.domCache.matchTextarea.value = this.storage.matchReplaceRulesText || '';
        }
        this.currentMatchRules = this.storage.matchReplaceRules || [];
        this.updateTabCounts();
        if (this.domCache.matchSave) {
            this.domCache.matchSave.addEventListener('click', () => {
                const text = this.domCache.matchTextarea ? this.domCache.matchTextarea.value : '';
                const rules = this.storage.parseMatchReplaceText(text || '');
                if (rules.length > MAX_USER_REGEX_RULES && this.domCache.matchTextarea) {
                    this.domCache.matchTextarea.setCustomValidity(`At most ${MAX_USER_REGEX_RULES} regex rules are allowed.`);
                    this.domCache.matchTextarea.reportValidity();
                    return;
                }
                const rejectedRule = rules
                    .map((rule: MatchReplaceRule) => ({ rule, result: compileSafeRegex(rule.pattern, 'g') }))
                    .find((entry) => !entry.result.regex);
                if (rejectedRule && this.domCache.matchTextarea) {
                    const error = rejectedRule.result.error || 'Invalid regular expression.';
                    this.domCache.matchTextarea.setCustomValidity(`Rejected pattern "${rejectedRule.rule.pattern}": ${error}`);
                    this.domCache.matchTextarea.reportValidity();
                    return;
                }
                this.domCache.matchTextarea?.setCustomValidity('');
                this.storage.saveMatchReplaceRules(rules, text || '');
                this.currentMatchRules = rules;
                this.updateTabCounts();
            });
        }
        if (this.domCache.matchReload) {
            this.domCache.matchReload.addEventListener('click', () => {
                if (this.currentTabId) {
                    chrome.tabs.reload(this.currentTabId).catch((error: unknown) => {
                        mainLog.error('Fransyfox: Failed to reload tab:', error);
                    });
                }
            });
        }
        if (this.domCache.matchPreview) {
            this.domCache.matchPreview.addEventListener('click', () => {
                this.runMatchReplacePreview();
            });
        }
    }
    setupGrepExtractPanel() {
        if (this.domCache.grepRegexInput) {
            this.domCache.grepRegexInput.value = this.storage.grepExtractRegex || '';
            this.domCache.grepRegexInput.addEventListener('input', () => {
                if (this._grepRegexSaveTimer) clearTimeout(this._grepRegexSaveTimer);
                this._grepRegexSaveTimer = setTimeout(() => {
                    const val = this.domCache.grepRegexInput ? this.domCache.grepRegexInput.value : '';
                    this.storage.saveGrepExtractRegex(val);
                }, 500);
            });
        }
        if (this.domCache.grepExtractBtn) {
            this.domCache.grepExtractBtn.addEventListener('click', () => {
                this.runGrepExtract();
            });
        }
        if (this.domCache.grepCopyBtn) {
            this.domCache.grepCopyBtn.addEventListener('click', () => {
                const text = this.domCache.grepResults ? this.domCache.grepResults.value : '';
                navigator.clipboard.writeText(text).catch((err: unknown) => {
                    mainLog.error('Fransyfox: Failed to copy to clipboard:', err);
                });
            });
        }
        if (this.domCache.grepDownloadBtn) {
            this.domCache.grepDownloadBtn.addEventListener('click', () => {
                const text = this.domCache.grepResults ? this.domCache.grepResults.value : '';
                const blob = new Blob([text], { type: 'text/plain' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = 'grep-extract-results.txt';
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                URL.revokeObjectURL(url);
            });
        }
        if (this.domCache.grepSortCheckbox) {
            this.domCache.grepSortCheckbox.addEventListener('change', () => {
                this.applyGrepPostProcessing();
            });
        }
        if (this.domCache.grepUniqueCheckbox) {
            this.domCache.grepUniqueCheckbox.addEventListener('change', () => {
                this.applyGrepPostProcessing();
            });
        }
    }
    runGrepExtract() {
        const pattern = this.domCache.grepRegexInput ? this.domCache.grepRegexInput.value : '';
        if (!pattern.trim()) {
            this._lastGrepRawResults = [];
            if (this.domCache.grepResults) this.domCache.grepResults.value = '';
            return;
        }
        const compiledRegex = compileSafeRegex(pattern, 'g');
        if (!compiledRegex.regex) {
            this._lastGrepRawResults = [];
            if (this.domCache.grepResults) {
                this.domCache.grepResults.value = `Rejected regex: ${compiledRegex.error || 'Invalid regular expression.'}`;
            }
            return;
        }
        const regex = compiledRegex.regex;
        const tabId = this.currentTabId;
        const messages = Array.isArray(this.currentMessages)
            ? this.currentMessages.filter((m: PanelMessageEvent) => m.tabId === tabId)
            : [];
        const results: string[] = [];
        for (const msg of messages) {
            if (!msg.dataText) continue;
            let match: RegExpExecArray | null;
            // Reset lastIndex for each message
            regex.lastIndex = 0;
            const input = limitRegexInput(msg.dataText);
            while ((match = regex.exec(input)) !== null) {
                results.push(match[0]);
                // Prevent infinite loops on zero-length matches
                if (match[0].length === 0) {
                    regex.lastIndex++;
                }
            }
        }
        this._lastGrepRawResults = results;
        this.applyGrepPostProcessing();
    }
    applyGrepPostProcessing() {
        let results = [...this._lastGrepRawResults];
        const doUnique = this.domCache.grepUniqueCheckbox ? this.domCache.grepUniqueCheckbox.checked : false;
        const doSort = this.domCache.grepSortCheckbox ? this.domCache.grepSortCheckbox.checked : false;
        if (doUnique) {
            results = [...new Set(results)];
        }
        if (doSort) {
            results.sort((a, b) => a.localeCompare(b));
        }
        if (this.domCache.grepResults) {
            this.domCache.grepResults.value = results.join('\n');
        }
    }
    runMatchReplacePreview() {
        const text = this.domCache.matchTextarea ? this.domCache.matchTextarea.value : '';
        const rules = this.storage.parseMatchReplaceText(text || '');
        const sample = this.domCache.matchSample ? this.domCache.matchSample.value : '';
        const resultEl = this.domCache.matchResult;
        if (!resultEl)
            return;
        if (!sample.trim()) {
            resultEl.textContent = 'Provide a sample payload to test.';
            return;
        }
        const compiled: Array<{ regex: RegExp; replacement: string }> = [];
        rules.forEach((rule: MatchReplaceRule) => {
            const result = compileSafeRegex(rule.pattern, 'g');
            if (result.regex) {
                compiled.push({
                    regex: result.regex,
                    replacement: rule.replacement || ''
                });
            }
            else {
                resultEl.textContent = `Rejected regex "${rule.pattern}": ${result.error || 'Invalid regular expression.'}`;
            }
        });
        if (compiled.length !== rules.length) return;
        let output = sample;
        let parsed: unknown = null;
        try {
            parsed = JSON.parse(sample);
            output = JSON.stringify(parsed);
        }
        catch {
            // Keep as raw string
        }
        compiled.forEach((rule) => {
            try {
                output = output.replace(rule.regex, rule.replacement);
            }
            catch {
                // Ignore
            }
        });
        if (parsed) {
            try {
                const maybeJson: unknown = JSON.parse(output);
                output = JSON.stringify(maybeJson, null, 2);
            }
            catch {
                // Keep as string
            }
        }
        resultEl.textContent = output;
    }
    updateViewMode() {
        if (this.domCache.listenersTab) {
            this.domCache.listenersTab.classList.toggle('active', this.viewMode === 'listeners');
        }
        if (this.domCache.messagesTab) {
            this.domCache.messagesTab.classList.toggle('active', this.viewMode === 'messages');
        }
        if (this.domCache.findingsTab) {
            this.domCache.findingsTab.classList.toggle('active', this.viewMode === 'findings');
        }
        if (this.domCache.matchTab) {
            this.domCache.matchTab.classList.toggle('active', this.viewMode === 'match');
        }
        if (this.domCache.mapTab) {
            this.domCache.mapTab.classList.toggle('active', this.viewMode === 'map');
        }
        if (this.domCache.timelineTab) {
            this.domCache.timelineTab.classList.toggle('active', this.viewMode === 'timeline');
        }
        if (this.domCache.messagesFilters) {
            // The timeline reuses the Messages filters, so show them there too.
            this.domCache.messagesFilters.classList.toggle(
                'active',
                this.viewMode === 'messages' || this.viewMode === 'timeline'
            );
        }
        if (this.domCache.findingsFilters) {
            this.domCache.findingsFilters.classList.toggle('active', this.viewMode === 'findings');
        }
        if (this.domCache.listenersToolbar) {
            this.domCache.listenersToolbar.classList.toggle('active', this.viewMode === 'listeners');
        }
        if (this.domCache.utilsPanel) {
            this.domCache.utilsPanel.classList.toggle('active', this.viewMode === 'match');
        }
        if (this.domCache.mapPanel) {
            this.domCache.mapPanel.classList.toggle('active', this.viewMode === 'map');
        }
        if (this.domCache.timelinePanel) {
            this.domCache.timelinePanel.classList.toggle('active', this.viewMode === 'timeline');
        }
        if (this.domCache.contentElement) {
            // Map, Timeline and Utils render into their own panels; hide the list content.
            this.domCache.contentElement.style.display =
                this.viewMode === 'match' || this.viewMode === 'map' || this.viewMode === 'timeline' ? 'none' : 'block';
        }
        this.updateMessageBeautifyButton();
        this.updateListenersBeautifyButton();
        this.updateMessagesExpandAllButton();
        this.renderStatusBadge();
    }
    async toggleExtensionActive() {
        if (this.extensionToggleInProgress)
            return;
        this.extensionToggleInProgress = true;
        const nextState = !this.extensionActive;
        try {
            const response: { active?: boolean } | undefined = await new Promise((resolve, reject) => {
                chrome.runtime.sendMessage({
                    action: 'updateExtensionActive',
                    enabled: nextState
                }, (result: { active?: boolean } | undefined) => {
                    if (chrome.runtime.lastError) {
                        reject(new Error(chrome.runtime.lastError.message));
                        return;
                    }
                    resolve(result);
                });
            });
            if (response && typeof response.active === 'boolean') {
                this.extensionActive = response.active;
            }
            else {
                this.extensionActive = nextState;
            }
            await this.requestData();
            await this.requestEvents();
            this.refreshDisplay(false);
        }
        catch (error) {
            mainLog.error('Fransyfox: Failed to toggle extension state:', error);
        }
        finally {
            this.extensionToggleInProgress = false;
            this.renderStatusBadge();
        }
    }
    renderStatusBadge() {
        const statusElement = this.domCache.statusElement;
        if (!statusElement)
            return;
        statusElement.classList.add('is-toggle');
        statusElement.setAttribute('role', 'button');
        statusElement.setAttribute('aria-live', 'polite');
        statusElement.className = this.extensionActive
            ? 'status-dot is-toggle'
            : 'status-dot inactive is-toggle';
        statusElement.setAttribute('aria-pressed', this.extensionActive ? 'true' : 'false');
        statusElement.title = this.extensionActive
            ? 'Active - click to deactivate'
            : 'Inactive - click to activate';
    }
    requestPreserveLogState() {
        chrome.runtime.sendMessage({ action: 'requestPreserveLog' }, (response: { enabled?: boolean } | undefined) => {
            if (chrome.runtime.lastError) {
                mainLog.warn('Fransyfox: Failed to fetch preserve log state:', chrome.runtime.lastError.message);
                return;
            }
            if (response && typeof response.enabled === 'boolean') {
                this.preserveLogEnabled = response.enabled;
                this.renderPreserveBadge();
            }
        });
    }
    async togglePreserveLog() {
        if (this.preserveLogToggleInProgress) return;
        this.preserveLogToggleInProgress = true;
        const nextState = !this.preserveLogEnabled;
        try {
            const response: { enabled?: boolean } | undefined = await new Promise((resolve, reject) => {
                chrome.runtime.sendMessage({
                    action: 'updatePreserveLog',
                    enabled: nextState
                }, (result: { enabled?: boolean } | undefined) => {
                    if (chrome.runtime.lastError) {
                        reject(new Error(chrome.runtime.lastError.message));
                        return;
                    }
                    resolve(result);
                });
            });
            if (response && typeof response.enabled === 'boolean') {
                this.preserveLogEnabled = response.enabled;
            } else {
                this.preserveLogEnabled = nextState;
            }
        } catch (error) {
            mainLog.error('Fransyfox: Failed to toggle preserve log:', error);
        } finally {
            this.preserveLogToggleInProgress = false;
            this.renderPreserveBadge();
        }
    }
    renderPreserveBadge() {
        const el = this.domCache.preserveElement;
        if (!el) return;
        el.className = this.preserveLogEnabled
            ? 'preserve-dot active'
            : 'preserve-dot';
        el.title = this.preserveLogEnabled
            ? 'Preserve log on navigation (on)'
            : 'Preserve log on navigation (off)';
    }
    updateTabCounts() {
        const listenersCount = Array.isArray(this.currentListeners) ? this.currentListeners.length : 0;
        const tabId = this.currentTabId;
        const messagesCount = Array.isArray(this.currentMessages)
            ? this.currentMessages.filter((message: MessageEventRecord) => message.tabId === tabId).length
            : 0;
        const findingsCount = this.getFindingsCount();
        if (this.domCache.listenersTab) {
            this.domCache.listenersTab.textContent = `${this.tabLabels.listeners} (${listenersCount})`;
        }
        if (this.domCache.messagesTab) {
            this.domCache.messagesTab.textContent = `${this.tabLabels.messages} (${messagesCount})`;
        }
        if (this.domCache.findingsTab) {
            this.domCache.findingsTab.textContent = `${this.tabLabels.findings} (${findingsCount})`;
        }
        if (this.domCache.matchTab) {
            this.domCache.matchTab.textContent = this.tabLabels.match;
        }
        if (this.domCache.listenerCountElement) {
            this.domCache.listenerCountElement.textContent = '';
        }
    }
    getMessageRecordKey(message: PanelMessageEvent): string {
        const id = message.id;
        if (typeof id === 'number' && Number.isFinite(id)) {
            return `id:${id}`;
        }
        return [
            message.ts || '',
            message.tabId || '',
            message.sourceFrame || '',
            message.targetFrame || '',
            message.origin || '',
            message.dataText || ''
        ].join('|');
    }
    mergeMessageEvents(incoming: PanelMessageEvent[], maxEvents: number) {
        if (!Array.isArray(incoming) || incoming.length === 0) {
            return;
        }
        const boundedMax = typeof maxEvents === 'number' && maxEvents > 0 ? maxEvents : 5000;
        // Fast path: event-store ids are strictly increasing and append
        // batches arrive ordered, so when the incoming batch is entirely
        // newer than what we have, just append and front-trim (keeps the
        // ascending-by-id invariant getFilteredMessages relies on).
        const lastExisting = this.currentMessages.length > 0
            ? this.currentMessages[this.currentMessages.length - 1]
            : null;
        const incomingFirstId = this.getMessageId(incoming[0]);
        if (lastExisting === null || incomingFirstId > this.getMessageId(lastExisting)) {
            this.currentMessages = this.currentMessages.concat(incoming);
            if (this.currentMessages.length > boundedMax) {
                this.currentMessages.splice(0, this.currentMessages.length - boundedMax);
            }
            return;
        }
        // Fallback: out-of-order arrival (snapshot races) - dedupe and re-sort.
        const byKey = new Map<string, PanelMessageEvent>();
        for (const message of this.currentMessages) {
            byKey.set(this.getMessageRecordKey(message), message);
        }
        for (const message of incoming) {
            byKey.set(this.getMessageRecordKey(message), message);
        }
        const merged = Array.from(byKey.values());
        merged.sort((left, right) => {
            const idDiff = this.getMessageId(left) - this.getMessageId(right);
            if (idDiff !== 0) return idDiff;
            return this.getMessageTimestamp(left) - this.getMessageTimestamp(right);
        });
        this.currentMessages = merged.length > boundedMax
            ? merged.slice(merged.length - boundedMax)
            : merged;
    }
    getFilteredMessages(): PanelMessageEvent[] {
        const tabId = this.currentTabId;
        const query = (this.messageFilters.query || '').trim().toLowerCase();
        const targetFrame = this.messageFilters.targetFrame;
        let list = Array.isArray(this.currentMessages) ? this.currentMessages : [];
        if (tabId !== null && tabId !== undefined) {
            list = list.filter((message: MessageEventRecord) => message.tabId === tabId);
        }
        if (targetFrame !== 'any') {
            list = list.filter((message: MessageEventRecord) => message.targetFrame === targetFrame);
        }
        if (query) {
            list = list.filter((message: MessageEventRecord) => {
                const haystack = [
                    message.dataText,
                    message.sourceFrame,
                    message.targetFrame,
                    message.pageUrl
                ].filter(Boolean).join(' ').toLowerCase();
                return haystack.includes(query);
            });
        }
        // currentMessages is maintained ascending by event-store id (capture
        // arrival order), and the filters above preserve that order, so no sort
        // is needed - just reverse a copy for descending display.
        // (`list` may still alias currentMessages if no filter ran; copy it.)
        const sortOrder = this.messageFilters.sortOrder === 'asc' ? 'asc' : 'desc';
        if (sortOrder === 'desc') {
            return list.slice().reverse();
        }
        return list === this.currentMessages ? list.slice() : list;
    }
    getFilteredListeners(): ListenerRecord[] {
        let list = Array.isArray(this.currentListeners) ? this.currentListeners : [];
        // Apply blocked/unblocked filter
        if (this.ui.showBlockedOnly) {
            list = list.filter((listener: ListenerRecord) => this.storage.isListenerBlocked(listener));
        } else {
            list = list.filter((listener: ListenerRecord) => !this.storage.isListenerBlocked(listener));
        }
        // Filter by domain
        const domain = this.listenerFilters.domain;
        if (domain && domain !== 'any') {
            list = list.filter((listener: ListenerRecord) => listener.domain === domain);
        }
        // Filter by search query
        const query = (this.listenerFilters.query || '').trim().toLowerCase();
        if (query) {
            list = list.filter((listener: ListenerRecord) => {
                const code = (listener.listener || '').toLowerCase();
                const listenerDomain = (listener.domain || '').toLowerCase();
                const stack = (listener.stack || '').toLowerCase();
                return code.includes(query) || listenerDomain.includes(query) || stack.includes(query);
            });
        }
        // Sort
        if (this.listenerFilters.sortOrder === 'desc') {
            list = list.slice().reverse();
        }
        return list;
    }
    updateListenersUrlOptions() {
        const urlFilter = this.domCache.listenersUrlFilter;
        if (!urlFilter) return;
        const current = (this.listenerFilters.domain || 'any').trim() || 'any';
        const domains = new Set<string>();
        for (const listener of this.currentListeners) {
            if (listener.domain) {
                domains.add(listener.domain);
            }
        }
        const options: string[] = ['any', ...Array.from(domains).sort()];
        urlFilter.innerHTML = '';
        options.forEach((value: string) => {
            const option = document.createElement('option');
            option.value = value;
            option.textContent = value === 'any' ? 'URL: Any' : value;
            urlFilter.appendChild(option);
        });
        const nextDomain = options.includes(current) ? current : 'any';
        urlFilter.value = nextDomain;
        if (this.listenerFilters.domain !== nextDomain) {
            this.listenerFilters.domain = nextDomain;
            this.persistListenerFilterSettings();
        }
    }
    async loadListenerFilterSettings() {
        try {
            const result = await chrome.storage.local.get(['listenerSortOrder', 'listenerDomain', 'listenerQuery']);
            if (result.listenerSortOrder === 'asc' || result.listenerSortOrder === 'desc') {
                this.listenerFilters.sortOrder = result.listenerSortOrder;
            }
            if (typeof result.listenerDomain === 'string') {
                this.listenerFilters.domain = result.listenerDomain;
            }
            if (typeof result.listenerQuery === 'string') {
                this.listenerFilters.query = result.listenerQuery;
            }
            this.syncListenerFilterControls();
            this.updateListenersUrlOptions();
        } catch (error) {
            mainLog.warn('Fransyfox: Failed to load listener filter settings:', error);
        }
    }
    syncListenerFilterControls() {
        if (this.domCache.listenersSearch) {
            this.domCache.listenersSearch.value = this.listenerFilters.query || '';
        }
        if (this.domCache.listenersDirection) {
            this.domCache.listenersDirection.value = this.listenerFilters.sortOrder === 'asc' ? 'asc' : 'desc';
        }
    }
    persistListenerFilterSettings() {
        void chrome.storage.local.set({
            listenerSortOrder: this.listenerFilters.sortOrder,
            listenerDomain: this.listenerFilters.domain,
            listenerQuery: this.listenerFilters.query
        });
    }
    scheduleListenerFilterSettingsSave() {
        if (this.listenerFilterSaveTimer) {
            clearTimeout(this.listenerFilterSaveTimer);
        }
        this.listenerFilterSaveTimer = setTimeout(() => {
            this.listenerFilterSaveTimer = null;
            this.persistListenerFilterSettings();
        }, 180);
    }
    getMessageTimestamp(message: PanelMessageEvent): number {
        const ts = message.ts;
        return typeof ts === 'number' && Number.isFinite(ts) ? ts : 0;
    }
    getMessageId(message: PanelMessageEvent): number {
        const id = message.id;
        return typeof id === 'number' && Number.isFinite(id) ? id : 0;
    }
    getFindingsCount() {
        if (!Array.isArray(this.currentListeners))
            return 0;
        let count = 0;
        for (const listener of this.currentListeners) {
            if (listener && this.storage.isListenerBlocked(listener)) {
                continue;
            }
            if (listener && Array.isArray(listener.findings)) {
                count += listener.findings.length;
            }
        }
        return count;
    }
    getListenerKey(listener: ListenerRecord | null | undefined) {
        if (!listener)
            return '';
        if (listener.listenerKey && typeof listener.listenerKey === 'string') {
            return listener.listenerKey;
        }
        const jsUrl = this.storage.extractJsUrlFromStack(listener.stack, listener.fullstack) || '';
        const hops = listener.hops || '';
        const domain = listener.domain || '';
        const listenerCode = listener.listener || '';
        const key = `${jsUrl}|${hops}|${domain}|${listenerCode}`;
        listener.listenerKey = key;
        return key;
    }
    syncMessageFilterControls() {
        if (this.domCache.messagesSearch) {
            this.domCache.messagesSearch.value = this.messageFilters.query || '';
        }
        if (this.domCache.messagesDirection) {
            this.domCache.messagesDirection.value = this.messageFilters.sortOrder === 'asc' ? 'asc' : 'desc';
        }
    }
    async persistMessageFilterSettings() {
        await this.storage.saveMessageViewSettings({
            query: this.messageFilters.query,
            targetFrame: this.messageFilters.targetFrame,
            sortOrder: this.messageFilters.sortOrder
        });
    }
    scheduleMessageSearch() {
        if (this.messageSearchDebounceTimer) {
            clearTimeout(this.messageSearchDebounceTimer);
        }
        this.messageSearchDebounceTimer = setTimeout(() => {
            this.messageSearchDebounceTimer = null;
            const query = this.domCache.messagesSearch
                ? this.domCache.messagesSearch.value
                : this.messageFilters.query;
            this.applyMessageSearchQuery(query, true);
        }, this.messageSearchDebounceDelay);
    }
    flushPendingMessageSearch(preserveScroll = true) {
        if (!this.messageSearchDebounceTimer) {
            return;
        }
        clearTimeout(this.messageSearchDebounceTimer);
        this.messageSearchDebounceTimer = null;
        const query = this.domCache.messagesSearch
            ? this.domCache.messagesSearch.value
            : this.messageFilters.query;
        this.applyMessageSearchQuery(query, preserveScroll);
    }
    applyMessageSearchQuery(query: string, preserveScroll = true, shouldRefresh = true) {
        if (this.messageFilters.query === query) {
            return;
        }
        this.messageFilters.query = query;
        this.scheduleMessageFilterSettingsSave();
        if (shouldRefresh && (this.viewMode === 'messages' || this.viewMode === 'timeline')) {
            this.refreshDisplay(preserveScroll);
        }
    }
    scheduleMessageFilterSettingsSave() {
        if (this.messageFilterSaveTimer) {
            clearTimeout(this.messageFilterSaveTimer);
        }
        this.messageFilterSaveTimer = setTimeout(() => {
            this.messageFilterSaveTimer = null;
            this.persistMessageFilterSettings().catch((error: unknown) => {
                mainLog.error('Fransyfox: Failed to save message filter settings:', error);
            });
        }, 180);
    }
    syncFindingsFilterControls() {
        if (this.domCache.findingsSearch) {
            this.domCache.findingsSearch.value = this.findingsFilters.query || '';
        }
        if (this.domCache.findingsSeverity) {
            this.domCache.findingsSeverity.value = this.findingsFilters.severity || 'any';
        }
    }
    resetFindingsFilters() {
        this.findingsFilters.query = '';
        this.findingsFilters.severity = 'any';
        this.findingsFilters.listenerKey = null;
        this.syncFindingsFilterControls();
    }
    showFindingsTab(listener: ListenerRecord | null | undefined) {
        if (listener) {
            this.findingsFilters.listenerKey = this.getListenerKey(listener);
            this.findingsFilters.query = '';
            this.findingsFilters.severity = 'any';
            this.syncFindingsFilterControls();
        }
        this.viewMode = 'findings';
        this.updateViewMode();
        this.refreshDisplay(false);
    }
    showListenerFromFinding(listener: ListenerRecord | null | undefined) {
        if (listener) {
            this.pendingListenerFocusKey = this.getListenerKey(listener);
        }
        if (this.ui.showBlockedOnly) {
            this.ui.showBlockedOnly = false;
            this.ui.updateShowBlockedButton();
        }
        this.viewMode = 'listeners';
        this.updateViewMode();
        this.refreshDisplay(false);
    }
    updateMessagesTargetOptions() {
        const messagesTarget = this.domCache.messagesTarget;
        if (!messagesTarget)
            return;
        const current = (this.messageFilters.targetFrame || 'any').trim() || 'any';
        const tabId = this.currentTabId;
        const targets = new Set<string>();
        for (const message of this.currentMessages) {
            if (tabId !== null && message.tabId !== tabId)
                continue;
            if (message.targetFrame) {
                targets.add(message.targetFrame);
            }
        }
        const options: string[] = ['any', ...Array.from(targets).sort()];
        // Skip the DOM rebuild when the option set and selection are unchanged
        // (this is called per append batch; rebuilding the <select> resets the
        // dropdown and is wasteful when no new target frame appeared).
        const signature = `${tabId}|${current}|${options.join('')}`;
        if (signature === this.lastMessagesTargetSignature) {
            return;
        }
        this.lastMessagesTargetSignature = signature;
        messagesTarget.innerHTML = '';
        options.forEach((value: string) => {
            const option = document.createElement('option');
            option.value = value;
            option.textContent = value === 'any' ? 'Target: Any' : value;
            messagesTarget.appendChild(option);
        });
        const nextTarget = options.includes(current) ? current : 'any';
        messagesTarget.value = nextTarget;
        if (this.messageFilters.targetFrame !== nextTarget) {
            this.messageFilters.targetFrame = nextTarget;
            this.persistMessageFilterSettings().catch((error: unknown) => {
                mainLog.error('Fransyfox: Failed to persist corrected target frame filter:', error);
            });
        }
    }
    exportMessages() {
        const filtered = this.getFilteredMessages();
        const blob = new Blob([JSON.stringify({
                exportedAt: new Date().toISOString(),
                count: filtered.length,
                events: filtered
            }, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'fransyfox-postmessage-events.json';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }
    exportListeners() {
        const listeners = Array.isArray(this.currentListeners) ? this.currentListeners : [];
        const blob = new Blob([JSON.stringify({
                exportedAt: new Date().toISOString(),
                count: listeners.length,
                tabId: this.currentTabId,
                currentUrl: this.currentUrl,
                listeners: listeners
            }, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'fransyfox-listeners.json';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }
    updateMessageBeautifyButton() {
        if (!this.domCache.messagesBeautify)
            return;
        const enabled = !!this.storage.messageBeautifyEnabled;
        this.domCache.messagesBeautify.textContent = '{ }';
        this.domCache.messagesBeautify.title = enabled ? 'Show raw message data' : 'Beautify JSON message data';
        this.domCache.messagesBeautify.classList.toggle('active', enabled);
    }
    updateListenersBeautifyButton() {
        if (!this.domCache.listenersBeautify)
            return;
        const enabled = !!this.storage.prettifyEnabled;
        this.domCache.listenersBeautify.textContent = '{ }';
        this.domCache.listenersBeautify.title = enabled ? 'Show raw listener code' : 'Beautify listener code';
        this.domCache.listenersBeautify.classList.toggle('active', enabled);
    }
    updateMessagesExpandAllButton() {
        if (!this.domCache.messagesExpandAll)
            return;
        const allExpanded = this.ui.areAllMessagesExpanded();
        this.domCache.messagesExpandAll.textContent = allExpanded ? '\u2195' : '\u2195';
        this.domCache.messagesExpandAll.title = allExpanded ? 'Collapse all message cards' : 'Expand all message cards';
        this.domCache.messagesExpandAll.classList.toggle('active', allExpanded);
    }
    exportFindings() {
        const allFindings = this.ui.buildFindingsList(this.currentListeners, true);
        const filtered = this.ui.applyFindingsFilters(allFindings, this.findingsFilters);
        const payload = filtered.map((entry: PanelFindingsEntry) => {
            const rule = entry.rule || {};
            const finding = entry.finding || {};
            const listener = entry.listener || ({ listener: '' } as ListenerRecord);
            return {
                ruleId: rule.id || finding.id || null,
                ruleTitle: rule.title || null,
                severity: rule.severity || 'medium',
                description: rule.description || null,
                details: finding.details || null,
                listener: {
                    domain: listener.domain || null,
                    window: listener.window || null,
                    hops: listener.hops || null,
                    stack: listener.stack || null,
                    fullstack: listener.fullstack || null,
                    listenerKey: listener.listenerKey || null,
                    sourceUrl: this.storage.extractJsUrlFromStack(listener.stack, listener.fullstack) || null,
                    listenerCode: listener.listener || null
                }
            };
        });
        const blob = new Blob([JSON.stringify({
                exportedAt: new Date().toISOString(),
                count: payload.length,
                filters: this.findingsFilters,
                findings: payload
            }, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'fransyfox-findings.json';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }
    clearFindings() {
        if (!this.currentTabId)
            return;
        if (!confirm('Clear all findings for this tab?'))
            return;
        chrome.runtime.sendMessage({ action: 'clearFindings', tabId: this.currentTabId }, (response: { success?: boolean; error?: string } | undefined) => {
            if (chrome.runtime.lastError) {
                mainLog.error('Fransyfox: Failed to clear findings:', chrome.runtime.lastError);
                return;
            }
            if (!response || !response.success) {
                mainLog.error('Fransyfox: Clear findings failed:', response && response.error);
                return;
            }
            this.resetFindingsFilters();
            this.refreshDisplay(false);
        });
    }
    // Cleanup method to prevent memory leaks
    destroy() {
        // Clear debounce timer
        if (this.updateDebounceTimer) {
            clearTimeout(this.updateDebounceTimer);
            this.updateDebounceTimer = null;
        }
        if (this.messageSearchDebounceTimer) {
            clearTimeout(this.messageSearchDebounceTimer);
            this.messageSearchDebounceTimer = null;
            const query = this.domCache.messagesSearch
                ? this.domCache.messagesSearch.value
                : this.messageFilters.query;
            this.applyMessageSearchQuery(query, false, false);
        }
        if (this.messageFilterSaveTimer) {
            clearTimeout(this.messageFilterSaveTimer);
            this.messageFilterSaveTimer = null;
            this.persistMessageFilterSettings().catch((error: unknown) => {
                mainLog.error('Fransyfox: Failed to flush message filter settings on destroy:', error);
            });
        }
        if (this.listenerFilterSaveTimer) {
            clearTimeout(this.listenerFilterSaveTimer);
            this.listenerFilterSaveTimer = null;
            this.persistListenerFilterSettings();
        }
        // Disconnect port
        if (this.port) {
            this.port.disconnect();
            this.port = null;
        }
        this.isPortConnected = false;
        // Clear DOM cache
        this.domCache = createEmptyDomCache();
        // Clear prettify cache
        if (this.ui && this.ui.clearPrettifyCache) {
            this.ui.clearPrettifyCache();
        }
        // Clear other references
        this.currentListeners = [];
        this.currentMessages = [];
    }
}
(globalThis as typeof globalThis & { PanelMain: typeof PanelMain }).PanelMain = PanelMain;
// Initialize panel when DOM is ready
const panelMain = new PanelMain();
function loaded() {
    void panelMain.init();
}
// Initialize when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', loaded);
}
else {
    loaded();
}
// Cleanup on page unload
window.addEventListener('beforeunload', () => {
    if (panelMain) {
        panelMain.destroy();
    }
});
