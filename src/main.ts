import { parseBridgeWindowMessage, TRACKER_EVENT_TO_BRIDGE, TRACKER_EVENT_TO_MAIN } from './contracts/messages';
import { compileBlacklist, matchesBlacklistText as matchesCompiledBlacklist } from './shared/blacklist-matcher';
import { serializeForCapture } from './shared/capture-serializer';
import { capListenerFullStack, captureListenerSource, sanitizeListenerRecord } from './shared/listener-limits';
import { createMessageConsoleSnapshot } from './shared/message-console-snapshot';
import { compileSafeRegex, limitRegexInput } from './shared/safe-regex';
import { createStableWrapperRegistry } from './shared/stable-wrapper-registry';
import { createWeakGenerationCache } from './shared/weak-generation-cache';
import type { CompiledBlacklist } from './shared/blacklist-matcher';
import type { StableWrapperRegistry } from './shared/stable-wrapper-registry';
import type { ListenerRecord } from './types/listener';
import type { MatchReplaceRule, MessageDebugSettings } from './types/settings';
// Main World Content Script - Enhanced PostMessage Tracker
(function () {
    'use strict';
    if (window.FransyfoxMainLoaded) {
        return;
    }
    window.FransyfoxMainLoaded = true;
    let loaded = false;
    const originalFunctionToString = Function.prototype.toString;
    // Store original APIs
    const originalAddEventListener = Window.prototype.addEventListener;
    const originalRemoveEventListener = Window.prototype.removeEventListener;
    const originalPushState = History.prototype.pushState;
    const originalMessagePortAddEventListener = MessagePort.prototype.addEventListener;
    const originalMessagePortRemoveEventListener = MessagePort.prototype.removeEventListener;
    const originalWindowPostMessage = Window.prototype.postMessage;
    const originalMessagePortPostMessage = MessagePort.prototype.postMessage;
    // Captured for the bridge transport so page tampering can't break it
    const OriginalCustomEvent = CustomEvent;
    const originalDispatchEvent = EventTarget.prototype.dispatchEvent;
    // Extension identifier for our own listeners
    const EXTENSION_MARKER = '__FRANSYFOX_INTERNAL__';
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
    // Extension blacklist - received from bridge.js which imports from shared/constants.js
    // Initialized with minimal fallback patterns for our own messages (in case bridge hasn't sent yet)
    // Compiled once per blacklist update so per-message matching is a single regex test.
    let compiledBlacklist: CompiledBlacklist = compileBlacklist(DEFAULT_EXTENSION_BLACKLIST);
    function isIgnoredEnvelopeRecord(record: Record<string, unknown>): boolean {
        const source = typeof record.source === 'string' ? record.source.toLowerCase() : '';
        if (source.startsWith('event-tracker-') || source.startsWith('fancytracker')) {
            return true;
        }
        return false;
    }
    function matchesBlacklistText(value: string, includeExtensionUrl = true): boolean {
        return matchesCompiledBlacklist(compiledBlacklist, value, includeExtensionUrl);
    }
    const MAX_BLACKLIST_SCAN_NODES = 1000;
    const MAX_BLACKLIST_STRING_SCAN_CHARS = 4096;
    function containsBlacklistedPayload(
        value: unknown,
        depth = 0,
        seen = new WeakSet<object>(),
        budget = { remaining: MAX_BLACKLIST_SCAN_NODES }
    ): boolean {
        if (depth > 5 || value === null || value === undefined || budget.remaining-- <= 0) {
            return false;
        }
        if (typeof value === 'string') {
            return matchesBlacklistText(value.slice(0, MAX_BLACKLIST_STRING_SCAN_CHARS));
        }
        if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint' || typeof value === 'symbol') {
            return false;
        }
        if (Array.isArray(value)) {
            for (let i = 0; i < value.length && budget.remaining > 0; i++) {
                if (containsBlacklistedPayload(value[i], depth + 1, seen, budget)) {
                    return true;
                }
            }
            return false;
        }
        const record = asRecord(value);
        if (!record) {
            return false;
        }
        if (seen.has(record)) {
            return false;
        }
        seen.add(record);
        if (isIgnoredEnvelopeRecord(record)) {
            return true;
        }
        for (const key in record) {
            if (budget.remaining <= 0) break;
            if (!Object.prototype.hasOwnProperty.call(record, key)) continue;
            if (matchesBlacklistText(key.slice(0, MAX_BLACKLIST_STRING_SCAN_CHARS))) {
                return true;
            }
            if (containsBlacklistedPayload(record[key], depth + 1, seen, budget)) {
                return true;
            }
        }
        return false;
    }
    const BLACKLIST_TYPE = 'FRANSYFOX_BLACKLIST';
    const BLACKLIST_REQUEST_TYPE = 'FRANSYFOX_BLACKLIST_REQUEST';
    // Stringify a listener once; toString can throw on proxies/revoked functions
    function safeListenerToString(listener: unknown): string {
        try {
            return typeof listener === 'function' ? originalFunctionToString.apply(listener) : String(listener ?? '');
        }
        catch (e) {
            return '';
        }
    }
    // Check if listener or stack contains extension patterns.
    // Pass listenerStr when the listener has already been stringified to avoid repeated toString calls.
    function isFromExtension(listener: unknown, stack: string | null | undefined, listenerStr?: string) {
        try {
            const listenerRecord = asRecord(listener);
            if (listenerRecord && listenerRecord[EXTENSION_MARKER]) {
                return true;
            }
            const str = listenerStr !== undefined ? listenerStr : safeListenerToString(listener);
            const stackStr = stack || '';
            const combined = str + ' ' + stackStr;
            if (matchesBlacklistText(combined, false)) {
                return true;
            }
        }
        catch (e) {
            // Ignore
        }
        return false;
    }
    const EVENT_TYPE = 'FRANSYFOX_EVENT';
    const RULES_TYPE = 'FRANSYFOX_RULES';
    const RULES_REQUEST_TYPE = 'FRANSYFOX_RULES_REQUEST';
    const SETTINGS_TYPE = 'FRANSYFOX_SETTINGS';
    const SETTINGS_REQUEST_TYPE = 'FRANSYFOX_SETTINGS_REQUEST';
    const ACTIVE_TYPE = 'FRANSYFOX_ACTIVE';
    const ACTIVE_REQUEST_TYPE = 'FRANSYFOX_ACTIVE_REQUEST';
    const SEND_TYPE = 'FRANSYFOX_SEND';
    let trackingActive = false;
    let matchReplaceRules: MatchReplaceRule[] = [];
    let compiledMatchReplace: Array<{ pattern: string; replacement: string; regex: RegExp }> = [];
    let matchReplaceGeneration = 0;
    const messageDebugSettings: MessageDebugSettings & { debugBreakRegex: RegExp | null } = {
        consoleLogEnabled: false,
        debugBreakEnabled: false,
        debugBreakMatch: '',
        maxCapturedMessageSize: 0,
        debugBreakRegex: null
    };
    function asRecord(value: unknown): Record<string, unknown> | null {
        if (typeof value !== 'object' || value === null) {
            return null;
        }
        return value as Record<string, unknown>;
    }
    // Check if the message contains data from ignored extensions
    // I should probably just have kept it simple and block solely wappalyzer + domlogger?
    // But this should allow us to just update the "extension_blacklist" with additional extensions we want blocked
    function isFromIgnoredExtension(data: unknown) {
        if (!data)
            return false;
        const dataRecord = asRecord(data);
        // Skip our own tracking messages
        if (dataRecord?.type === 'FRANSYFOX_DATA') {
            return true;
        }
        if (dataRecord?.type === EVENT_TYPE) {
            return true;
        }
        if (dataRecord?.type === RULES_TYPE) {
            return true;
        }
        if (dataRecord?.type === RULES_REQUEST_TYPE) {
            return true;
        }
        if (dataRecord?.type === SETTINGS_TYPE) {
            return true;
        }
        if (dataRecord?.type === SETTINGS_REQUEST_TYPE) {
            return true;
        }
        if (dataRecord?.type === ACTIVE_TYPE) {
            return true;
        }
        if (dataRecord?.type === ACTIVE_REQUEST_TYPE) {
            return true;
        }
        if (dataRecord?.type === BLACKLIST_TYPE) {
            return true;
        }
        if (dataRecord?.type === BLACKLIST_REQUEST_TYPE) {
            return true;
        }
        if (dataRecord && isIgnoredEnvelopeRecord(dataRecord)) {
            return true;
        }
        return containsBlacklistedPayload(data);
    }
    // Send an envelope to the bridge (ISOLATED world) via a document
    // CustomEvent. Page 'message' listeners never see tracker traffic this
    // way, so capturing a message does not amplify page message dispatch.
    const sendToBridge = function (type: string, detail?: unknown) {
        try {
            originalDispatchEvent.call(document, new OriginalCustomEvent(TRACKER_EVENT_TO_BRIDGE, {
                detail: JSON.stringify({ type: type, detail: detail })
            }));
        }
        catch (error) {
            // Ignore - never break the page over tracker transport
        }
    };
    // Send listener data to bridge
    const m = function (detail: Record<string, unknown>) {
        if (!trackingActive)
            return;
        sendToBridge('FRANSYFOX_DATA', detail);
    };
    // Get frame hops info
    const h = function (p?: unknown) {
        let hops = "";
        try {
            const currentWindow = (p && typeof p === 'object' && 'top' in p)
                ? (p as Window)
                : window;
            if (currentWindow.top != currentWindow && currentWindow.top == window.top) {
                let w = currentWindow;
                while (top != w) {
                    let x = 0;
                    for (let i = 0; i < w.parent.frames.length; i++) {
                        if (w == w.parent.frames[i])
                            x = i;
                    }
                    hops = "frames[" + x + "]" + (hops.length ? '.' : '') + hops;
                    w = w.parent;
                }
                hops = "top" + (hops.length ? '.' + hops : '');
            }
            else {
                hops = currentWindow.top == window.top ? "top" : "diffwin";
            }
        }
        catch (e) {
            hops = "unknown";
        }
        return hops;
    };
    // Frame-hop caching for the per-message hot path. Target hops only change
    // when the frame tree around this window changes; source hops are stable
    // per source window. A stale frames[i] label for up to the TTL is
    // display-only metadata, so a short TTL is acceptable.
    const HOPS_CACHE_TTL_MS = 2000;
    let cachedTargetHops: string | null = null;
    let cachedTargetHopsTs = 0;
    const sourceHopsCache = new WeakMap<object, { hops: string; ts: number }>();
    const originalWeakMapGet = WeakMap.prototype.get;
    const originalWeakMapSet = WeakMap.prototype.set;
    const getTargetHops = function (): string {
        const now = Date.now();
        if (cachedTargetHops === null || now - cachedTargetHopsTs > HOPS_CACHE_TTL_MS) {
            cachedTargetHops = h();
            cachedTargetHopsTs = now;
        }
        return cachedTargetHops;
    };
    const getSourceHops = function (source: unknown): string {
        if (!source || typeof source !== 'object') {
            return h(source ?? undefined);
        }
        const now = Date.now();
        try {
            const cached = originalWeakMapGet.call(sourceHopsCache, source) as { hops: string; ts: number } | undefined;
            if (cached && now - cached.ts <= HOPS_CACHE_TTL_MS) {
                return cached.hops;
            }
            const hops = h(source);
            originalWeakMapSet.call(sourceHopsCache, source, { hops, ts: now });
            return hops;
        }
        catch (e) {
            return h(source);
        }
    };
    // Handle jQuery listeners
    const jq = function (instance: any) {
        if (!instance || !instance.message || !instance.message.length)
            return;
        let j = 0;
        let e;
        while (e = instance.message[j++]) {
            const listener = e.handler;
            if (!listener)
                continue;
            const listenerStr = safeListenerToString(listener);
            // Check if this is from an extension
            if (isFromExtension(listener, '', listenerStr)) {
                continue;
            }
            const capturedListener = captureListenerSource(listenerStr);
            const listenerPayload: ListenerRecord = {
                window: window.top == window ? 'top' : window.name,
                hops: h(),
                domain: document.domain,
                stack: 'jQuery',
                listener: capturedListener.text,
                listenerCaptureHash: capturedListener.hash,
                listenerLength: capturedListener.length,
                listenerTruncated: capturedListener.truncated
            };
            sanitizeListenerRecord(listenerPayload);
            m(listenerPayload);
        }
    };
    // Log listener with stack trace.
    // Callers have already checked the listener string + extension marker via
    // isFromExtension, so only the stack needs scanning here. listenerStr is
    // the pre-computed listener source (avoids repeated toString calls).
    const l = function (listener: ((...args: unknown[]) => unknown) & Record<string, unknown>, pattern_before: RegExp | false | null, additional_offset: number, listenerStr?: string) {
        const offset = 3 + (additional_offset || 0);
        let stack, fullstack;
        try {
            throw new Error('');
        }
        catch (error: unknown) {
            stack = error instanceof Error ? (error.stack || '') : '';
        }
        stack = capListenerFullStack(stack.split('\n').map(function (line: string) { return line.trim(); })) || [];
        fullstack = stack.slice();
        // Check if the registration stack points at an extension
        if (matchesBlacklistText(fullstack.join(' '), false)) {
            return; // Ignore extension listeners
        }
        if (pattern_before) {
            let nextitem = false;
            stack = stack.filter(function (e: string) {
                if (nextitem) {
                    nextitem = false;
                    return true;
                }
                if (e.match && e.match(pattern_before)) {
                    nextitem = true;
                }
                return false;
            });
            stack = stack[0];
        }
        else {
            stack = stack[offset];
        }
        const listener_str = listener.__postmessagetrackername__
            || (listenerStr !== undefined ? listenerStr : safeListenerToString(listener));
        const capturedListener = captureListenerSource(String(listener_str));
        const listenerPayload: ListenerRecord = {
            window: window.top == window ? 'top' : window.name,
            hops: h(),
            domain: document.domain,
            stack: stack,
            fullstack: fullstack,
            listener: capturedListener.text,
            listenerCaptureHash: capturedListener.hash,
            listenerLength: capturedListener.length,
            listenerTruncated: capturedListener.truncated
        };
        sanitizeListenerRecord(listenerPayload);
        m(listenerPayload);
    };
    // Check jQuery instances
    const jqc = function (key: string) {
        const windowEntry = window[key];
        if (typeof windowEntry == 'function' && typeof windowEntry._data == 'function') {
            const ev = windowEntry._data(window, 'events');
            if (ev)
                jq(ev);
        }
        else if (windowEntry && windowEntry.expando) {
            const expando = windowEntry.expando;
            let i = 1;
            let instance;
            while (instance = window[expando + i++]) {
                if (instance.events)
                    jq(instance.events);
            }
        }
        else if (window[key] && window[key].events) {
            jq(window[key].events);
        }
    };
    // Find all jQuery instances
    let jqueryDetectionRan = false;
    const j = function () {
        if (!trackingActive)
            return;
        if (jqueryDetectionRan)
            return;
        jqueryDetectionRan = true;
        const all = Object.getOwnPropertyNames(window);
        const len = all.length;
        for (let i = 0; i < len; i++) {
            const key = all[i];
            if (key.indexOf('jQuery') !== -1) {
                jqc(key);
            }
        }
        loaded = true;
    };
    // Hook History.pushState
    History.prototype.pushState = function (state: unknown, title: string, url?: string | URL | null) {
        if (trackingActive) {
            m({ pushState: true });
        }
        return originalPushState.call(this, state, title, url);
    };
    // Hook onmessage setter
    try {
        const original_setter = (window as any).__lookupSetter__('onmessage');
        if (original_setter) {
            (window as any).__defineSetter__('onmessage', function (listener: any) {
                if (trackingActive && listener) {
                    const listenerStr = safeListenerToString(listener);
                    if (!isFromExtension(listener, '', listenerStr)) {
                        l(listener, null, 0, listenerStr);
                        listener = wrapMessageListener(listener);
                    }
                }
                original_setter(listener);
            });
        }
    }
    catch (e) {
        console.warn('Fransyfox: Error in onmessage setter hook:', e);
    }
    // Wrapper detection function - enhanced from original
    const c = function (listener: any, listenerStr?: string) {
        try {
            const listener_str = listenerStr !== undefined ? listenerStr : originalFunctionToString.apply(listener);
            // Enhanced wrapper detection
            if (listener_str.match(/\.deep.*apply.*captureException/s))
                return 'raven';
            else if (listener_str.match(/arguments.*(start|typeof).*err.*finally.*end/s) && listener["nr@original"])
                return 'newrelic';
            else if (listener_str.match(/rollbarContext.*rollbarWrappedError/s) && listener._isWrap)
                return 'rollbar';
            else if (listener_str.match(/autoNotify.*(unhandledException|notifyException)/s) && typeof listener.bugsnag == "function")
                return 'bugsnag';
            else if (listener_str.match(/call.*arguments.*typeof.*apply/s) && typeof listener.__sentry_original__ == "function")
                return 'sentry';
            else if (listener_str.match(/function.*function.*\.apply.*arguments/s) && typeof listener.__trace__ == "function")
                return 'bugsnag2';
            return false;
        }
        catch (error) {
            return false;
        }
    };
    function normalizeMessageData(data: unknown) {
        return serializeForCapture(data, messageDebugSettings.maxCapturedMessageSize);
    }
    function emitMessageEvent(payload: Record<string, unknown>) {
        if (!trackingActive)
            return;
        sendToBridge(EVENT_TYPE, payload);
    }
    function updateMessageDebugSettings(settings: Partial<MessageDebugSettings> | null | undefined) {
        messageDebugSettings.consoleLogEnabled = !!(settings && settings.consoleLogEnabled);
        messageDebugSettings.debugBreakEnabled = !!(settings && settings.debugBreakEnabled);
        messageDebugSettings.debugBreakMatch = settings && typeof settings.debugBreakMatch === 'string'
            ? settings.debugBreakMatch
            : '';
        messageDebugSettings.maxCapturedMessageSize =
            settings && typeof settings.maxCapturedMessageSize === 'number' && isFinite(settings.maxCapturedMessageSize)
                ? Math.max(0, Math.floor(settings.maxCapturedMessageSize))
                : 0;
        messageDebugSettings.debugBreakRegex = null;
        if (messageDebugSettings.debugBreakMatch) {
            const compiled = compileSafeRegex(messageDebugSettings.debugBreakMatch, 'i');
            messageDebugSettings.debugBreakRegex = compiled.regex;
            if (!compiled.regex) {
                console.warn('Fransyfox: Rejected unsafe or invalid debug break regex:', messageDebugSettings.debugBreakMatch, compiled.error);
            }
        }
    }
    function maybeLogMessage(payload: Record<string, unknown> | null) {
        if (!payload)
            return;
        if (messageDebugSettings.consoleLogEnabled) {
            const headerStyle = 'background:#111827;color:#f8fafc;padding:2px 6px;border-radius:3px;font-weight:700;';
            const channelStyle = 'color:#2563eb;font-weight:700;';
            const snapshot = createMessageConsoleSnapshot(payload);
            // Avoid console.trace and live MessageEvent references: both are
            // expensive under message load, while the detached snapshot still
            // contains the complete captured dataText.
            console.log('%cFransyfox%c postMessage %c' + snapshot.channel, headerStyle, 'color:#111827;font-weight:600;', channelStyle, snapshot);
        }
        if (messageDebugSettings.debugBreakEnabled && messageDebugSettings.debugBreakRegex) {
            try {
                const dataText = typeof payload.dataText === 'string' ? payload.dataText : '';
                if (messageDebugSettings.debugBreakRegex.test(limitRegexInput(dataText))) {
                    console.log('%cFransyfox%c debugger break (matched: "' + messageDebugSettings.debugBreakMatch + '")', 'background:#dc2626;color:#fef2f2;padding:2px 6px;border-radius:3px;font-weight:700;', 'color:#111827;font-weight:600;');
                    debugger;
                }
            }
            catch (error) {
                // Ignore match errors
            }
        }
    }
    function compileMatchReplaceRules(rules: MatchReplaceRule[] | null | undefined) {
        matchReplaceGeneration++;
        compiledMatchReplace = [];
        if (!rules || !rules.length)
            return;
        for (let i = 0; i < rules.length; i++) {
            const rule = rules[i];
            if (!rule || !rule.pattern)
                continue;
            const compiled = compileSafeRegex(rule.pattern, 'g');
            if (compiled.regex) {
                compiledMatchReplace.push({
                    pattern: rule.pattern,
                    replacement: rule.replacement || '',
                    regex: compiled.regex
                });
            }
            else {
                console.warn('Fransyfox: Rejected unsafe or invalid match/replace regex:', rule.pattern, compiled.error);
            }
        }
    }
    function applyMatchReplaceToString(text: string) {
        if (!compiledMatchReplace.length || typeof text !== 'string') {
            return text;
        }
        let result = text;
        for (let i = 0; i < compiledMatchReplace.length; i++) {
            const rule = compiledMatchReplace[i];
            try {
                result = result.replace(rule.regex, rule.replacement);
            }
            catch (error) {
                // Ignore rule errors
            }
        }
        return result;
    }
    function applyMatchReplaceToData(data: unknown) {
        if (!trackingActive)
            return data;
        if (!compiledMatchReplace.length)
            return data;
        const dataRecord = asRecord(data);
        if (dataRecord && typeof dataRecord.type === 'string') {
            if (dataRecord.type === EVENT_TYPE || dataRecord.type === RULES_TYPE || dataRecord.type === RULES_REQUEST_TYPE
                || dataRecord.type === SETTINGS_TYPE || dataRecord.type === SETTINGS_REQUEST_TYPE
                || dataRecord.type === ACTIVE_TYPE || dataRecord.type === ACTIVE_REQUEST_TYPE
                || dataRecord.type === BLACKLIST_TYPE || dataRecord.type === BLACKLIST_REQUEST_TYPE
                || dataRecord.type === 'FRANSYFOX_DATA') {
                return data;
            }
        }
        if (typeof data === 'string') {
            return applyMatchReplaceToString(data);
        }
        if (data && typeof data === 'object') {
            try {
                const json = JSON.stringify(data);
                const replaced = applyMatchReplaceToString(json);
                if (replaced === json)
                    return data;
                try {
                    return JSON.parse(replaced);
                }
                catch (error) {
                    // If replacement broke JSON, keep original to avoid breaking apps
                    return data;
                }
            }
            catch (error) {
                return data;
            }
        }
        return data;
    }
    function createPatchedMessageEvent(event: MessageEvent, patchedData: unknown) {
        if (!event)
            return event;
        if (patchedData === event.data)
            return event;
        try {
            return new MessageEvent(event.type || 'message', {
                data: patchedData,
                origin: event.origin,
                lastEventId: event.lastEventId,
                source: event.source,
                ports: Array.from(event.ports || [])
            });
        }
        catch (error) {
            try {
                Object.defineProperty(event, 'data', {
                    value: patchedData,
                    configurable: true
                });
                return event;
            }
            catch (innerError) {
                return event;
            }
        }
    }
    const patchedMessageEventCache = createWeakGenerationCache<MessageEvent, MessageEvent>((event) => {
        const patchedData = applyMatchReplaceToData(event.data);
        return createPatchedMessageEvent(event, patchedData);
    });
    function getPatchedMessageEvent(event: MessageEvent): MessageEvent {
        if (!trackingActive || !compiledMatchReplace.length) {
            return event;
        }
        return patchedMessageEventCache.get(event, matchReplaceGeneration);
    }
    type TrackerMessageListener = ((this: unknown, event: MessageEvent) => unknown) & {
        __fransyfox_wrapped__?: boolean;
        __postmessagetrackername__?: string;
        name?: string;
    };
    function createMessageListenerWrapperRegistry() {
        return createStableWrapperRegistry<TrackerMessageListener>((listener) => {
            const wrapped: TrackerMessageListener = function (this: unknown, event: MessageEvent) {
                if (!trackingActive || !event || !compiledMatchReplace.length) {
                    return listener.call(this, event);
                }
                const patchedEvent = getPatchedMessageEvent(event);
                return listener.call(this, patchedEvent);
            };
            wrapped.__fransyfox_wrapped__ = true;
            try {
                wrapped.__postmessagetrackername__ = listener.__postmessagetrackername__ || listener.name || '';
            }
            catch (e) {
                // Ignore
            }
            return wrapped;
        });
    }
    const windowMessageListenerWrappers = createMessageListenerWrapperRegistry();
    const messagePortListenerWrappers = createMessageListenerWrapperRegistry();
    function wrapMessageListener(
        listener: unknown,
        identity: unknown = listener,
        registry: StableWrapperRegistry<TrackerMessageListener> = windowMessageListenerWrappers
    ) {
        if (typeof listener !== 'function' || typeof identity !== 'function')
            return listener;
        return registry.getOrCreate(
            identity as TrackerMessageListener,
            listener as TrackerMessageListener
        );
    }
    function resolveMessageListener(
        listener: unknown,
        registry: StableWrapperRegistry<TrackerMessageListener> = windowMessageListenerWrappers
    ) {
        if (typeof listener !== 'function')
            return listener;
        return registry.resolve(listener as TrackerMessageListener);
    }
    // Message capture functions
    const onmsgport = function (e: MessageEvent) {
        try {
            if (!trackingActive)
                return;
            // Skip messages from ignored extensions
            if (isFromIgnoredExtension(e.data)) {
                return;
            }
            const normalized = normalizeMessageData(getPatchedMessageEvent(e).data);
            const payload: Record<string, unknown> = {
                kind: 'message',
                channel: 'port',
                sourceFrame: getSourceHops(e.source),
                targetFrame: getTargetHops(),
                origin: e.origin || null,
                portsCount: e.ports ? e.ports.length : 0,
                dataType: normalized.dataType,
                dataText: normalized.dataText,
                dataTruncated: normalized.dataTruncated,
                dataLength: normalized.dataLength
            };
            maybeLogMessage(payload);
            emitMessageEvent(payload);
        }
        catch (error) {
            // Ignore console errors
        }
    };
    const onmsg = function (e: MessageEvent) {
        try {
            if (!trackingActive)
                return;
            // Skip messages from ignored extensions
            if (isFromIgnoredExtension(e.data)) {
                return;
            }
            const normalized = normalizeMessageData(getPatchedMessageEvent(e).data);
            const payload: Record<string, unknown> = {
                kind: 'message',
                channel: 'window',
                sourceFrame: getSourceHops(e.source),
                targetFrame: getTargetHops(),
                origin: e.origin || null,
                portsCount: e.ports ? e.ports.length : 0,
                dataType: normalized.dataType,
                dataText: normalized.dataText,
                dataTruncated: normalized.dataTruncated,
                dataLength: normalized.dataLength
            };
            maybeLogMessage(payload);
            emitMessageEvent(payload);
        }
        catch (error) {
            // Ignore console errors
        }
    };
    // Mark our own listeners
    onmsg[EXTENSION_MARKER] = true;
    onmsgport[EXTENSION_MARKER] = true;
    // Hook MessagePort
    MessagePort.prototype.addEventListener = function (type: any, listener: any, useCapture: any) {
        if (trackingActive && !this.__postmessagetrackername__) {
            this.__postmessagetrackername__ = true;
            // Install tracker instrumentation through the captured native API.
            // Sending it through our hook would apply match/replace twice.
            originalMessagePortAddEventListener.call(this, 'message', onmsgport as unknown as EventListener);
        }
        if (type === 'message' && typeof listener === 'function' && !listener[EXTENSION_MARKER]) {
            // Always use the stable wrapper, even while inactive or with no
            // rules. Its behavior is a pass-through until rules are enabled.
            listener = wrapMessageListener(listener, listener, messagePortListenerWrappers);
        }
        return originalMessagePortAddEventListener.call(this, type, listener, useCapture);
    };
    MessagePort.prototype.removeEventListener = function (
        type: string,
        listener: EventListenerOrEventListenerObject,
        useCapture?: boolean | EventListenerOptions
    ) {
        const resolved = type === 'message'
            ? resolveMessageListener(listener, messagePortListenerWrappers)
            : listener;
        return originalMessagePortRemoveEventListener.call(
            this,
            type,
            resolved as EventListenerOrEventListenerObject,
            useCapture
        );
    };
    // Hook Window.postMessage to apply match/replace rules
    (Window.prototype as any).postMessage = function (message: any, targetOrigin: any, transfer: any) {
        try {
            if (!trackingActive) {
                return (originalWindowPostMessage as any).apply(this, arguments as any);
            }
            const patched = applyMatchReplaceToData(message);
            return (originalWindowPostMessage as any).call(this, patched, targetOrigin, transfer);
        }
        catch (error) {
            console.warn('Fransyfox: Error in Window.postMessage hook:', error);
            return (originalWindowPostMessage as any).apply(this, arguments as any);
        }
    };
    // Hook MessagePort.postMessage to apply match/replace rules
    (MessagePort.prototype as any).postMessage = function (message: any, transfer: any) {
        try {
            if (!trackingActive) {
                return (originalMessagePortPostMessage as any).apply(this, arguments as any);
            }
            const patched = applyMatchReplaceToData(message);
            return (originalMessagePortPostMessage as any).call(this, patched, transfer);
        }
        catch (error) {
            console.warn('Fransyfox: Error in MessagePort.postMessage hook:', error);
            return (originalMessagePortPostMessage as any).apply(this, arguments as any);
        }
    };
    // Check if listener is our own extension
    function isExtensionListener(listener: any, listenerStr?: string) {
        if (listener && listener[EXTENSION_MARKER])
            return true;
        return isFromExtension(listener, '', listenerStr);
    }
    // Main hook - Window.addEventListener
    Window.prototype.addEventListener = function (type: any, listener: any, useCapture: any) {
        const registeredListener = listener;
        if (trackingActive && type == 'message') {
            // Stringify once; threaded through every check below
            const listenerStr = safeListenerToString(listener);
            // Skip our own extension listeners
            if (isExtensionListener(listener, listenerStr)) {
                return (originalAddEventListener as any).apply(this, arguments as any);
            }
            let pattern_before: any = false;
            let offset = 0;
            if (listener && listenerStr.indexOf('event.dispatch.apply') !== -1) {
                pattern_before = /init\.on|init\..*on\]/;
                if (loaded) {
                    setTimeout(j, 100);
                }
            }
            // Enhanced unwrap function. str is the pre-computed source of this
            // listener; recursive calls on unwrapped inner functions re-stringify.
            const unwrap = function (listener: any, str?: string) {
                const found = c(listener, str);
                if (found) {
                    m({ log: 'Unwrapping ' + found + ' wrapper' });
                }
                if (found == 'raven') {
                    let ff = 0;
                    let f = null;
                    for (const key in listener) {
                        const v = listener[key];
                        if (typeof v == "function") {
                            ff++;
                            f = v;
                        }
                    }
                    if (ff == 1 && f) {
                        offset++;
                        listener = unwrap(f);
                    }
                }
                else if (found == 'newrelic') {
                    offset++;
                    listener = unwrap(listener["nr@original"]);
                }
                else if (found == 'sentry') {
                    offset++;
                    listener = unwrap(listener["__sentry_original__"]);
                }
                else if (found == 'rollbar') {
                    offset += 2;
                    if (listener._wrapped) {
                        listener = unwrap(listener._wrapped);
                    }
                    else if (listener._rollbar_wrapped) {
                        listener = unwrap(listener._rollbar_wrapped);
                    }
                }
                else if (found == 'bugsnag' || found == 'bugsnag2') {
                    // Bugsnag wrapper detected - offset the stack trace
                    // Note: Previously attempted to unwrap via arguments.callee.caller chain,
                    // but this is deprecated, fails in strict mode, and is unreliable with bundlers
                    offset++;
                }
                if (listener && listener.name && listener.name.indexOf('bound ') === 0) {
                    listener.__postmessagetrackername__ = listener.name;
                }
                return listener;
            };
            if (typeof listener == "function") {
                const original = listener;
                listener = unwrap(listener, listenerStr);
                const unwrappedStr = listener === original ? listenerStr : safeListenerToString(listener);
                l(listener, pattern_before, offset, unwrappedStr);
            }
        }
        if (type === 'message'
            && typeof listener === 'function'
            && !(registeredListener && registeredListener[EXTENSION_MARKER])) {
            listener = wrapMessageListener(listener, registeredListener);
        }
        return originalAddEventListener.call(this, type, listener, useCapture);
    };
    Window.prototype.removeEventListener = function (
        type: string,
        listener: EventListenerOrEventListenerObject,
        useCapture?: boolean | EventListenerOptions
    ) {
        const resolved = type === 'message' ? resolveMessageListener(listener) : listener;
        return originalRemoveEventListener.call(
            this,
            type,
            resolved as EventListenerOrEventListenerObject,
            useCapture
        );
    };
    function setTrackingActive(active: boolean) {
        const normalized = active !== false;
        if (trackingActive === normalized)
            return;
        trackingActive = normalized;
        if (trackingActive) {
            jqueryDetectionRan = false;
            window.addEventListener('load', j);
            window.addEventListener('postMessageTrackerUpdate', j);
            window.addEventListener('message', onmsg);
            setTimeout(j, 0);
        }
        else {
            window.removeEventListener('load', j);
            window.removeEventListener('postMessageTrackerUpdate', j);
            window.removeEventListener('message', onmsg);
        }
    }
    // Add message logger
    onmsg[EXTENSION_MARKER] = true;
    // Receive control envelopes (rules/settings/blacklist/active) from the
    // bridge via the document CustomEvent transport.
    const onBridgeEnvelope = function (event: Event) {
        const detailRaw = (event as CustomEvent).detail;
        if (typeof detailRaw !== 'string')
            return;
        let parsed: unknown;
        try {
            parsed = JSON.parse(detailRaw);
        }
        catch (error) {
            return;
        }
        const message = parseBridgeWindowMessage(parsed);
        if (!message)
            return;
        const detail = asRecord((message as { detail?: unknown }).detail) || {};
        if (message.type === RULES_TYPE && detail && detail.rules) {
            matchReplaceRules = detail.rules as MatchReplaceRule[];
            compileMatchReplaceRules(matchReplaceRules);
            return;
        }
        if (message.type === SETTINGS_TYPE) {
            updateMessageDebugSettings(detail);
            return;
        }
        if (message.type === BLACKLIST_TYPE && Array.isArray(detail.blacklist)) {
            const incoming = detail.blacklist.filter((value): value is string => typeof value === 'string');
            compiledBlacklist = compileBlacklist(Array.from(new Set([...DEFAULT_EXTENSION_BLACKLIST, ...incoming])));
            return;
        }
        if (message.type === ACTIVE_TYPE) {
            setTrackingActive(detail.active !== false);
            return;
        }
        if (message.type === SEND_TYPE) {
            deliverComposedMessage(detail);
        }
    };
    // Composer: deliver a panel-crafted postMessage from this frame. Uses the
    // captured original postMessage so match/replace rules don't mutate the
    // exact payload the user typed; the tracker still captures it on receipt.
    function deliverComposedMessage(detail: Record<string, unknown>): void {
        try {
            const target = typeof detail.target === 'string' ? detail.target : 'self';
            const payloadType = detail.payloadType === 'json' ? 'json' : 'string';
            const rawPayload = typeof detail.payload === 'string' ? detail.payload : '';
            const targetOrigin = typeof detail.targetOrigin === 'string' && detail.targetOrigin
                ? detail.targetOrigin
                : '*';
            let data: unknown = rawPayload;
            if (payloadType === 'json') {
                try {
                    data = JSON.parse(rawPayload);
                }
                catch {
                    console.warn('Fransyfox: Composer payload is not valid JSON; sending as string.');
                    data = rawPayload;
                }
            }
            let targetWindow: Window | null = window;
            if (target === 'top') {
                targetWindow = window.top;
            }
            else if (target === 'parent') {
                targetWindow = window.parent;
            }
            else if (target === 'opener') {
                targetWindow = window.opener as Window | null;
            }
            if (!targetWindow) {
                console.warn('Fransyfox: Composer target window unavailable:', target);
                return;
            }
            (originalWindowPostMessage as (this: Window, message: unknown, targetOrigin: string, transfer?: Transferable[]) => void)
                .call(targetWindow, data, targetOrigin);
        }
        catch (error) {
            console.warn('Fransyfox: Composer send failed:', error);
        }
    }
    document.addEventListener(TRACKER_EVENT_TO_MAIN, onBridgeEnvelope);
    // Activate immediately: this script is only injected while the extension
    // is registered as active, so gating on an async bridge roundtrip only
    // loses listener registrations that happen during page startup.
    setTrackingActive(true);
    // Request initial data in case the bridge sent them before we were ready
    sendToBridge(ACTIVE_REQUEST_TYPE);
    sendToBridge(BLACKLIST_REQUEST_TYPE);
    sendToBridge(RULES_REQUEST_TYPE);
    sendToBridge(SETTINGS_REQUEST_TYPE);
    console.log('Fransyfox: Initialized in', h());
})();
