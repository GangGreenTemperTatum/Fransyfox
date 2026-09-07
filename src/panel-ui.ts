export {};
import type { Finding, ListenerRecord } from './types/listener';
// UI utilities and DOM manipulation for Fransyfox - Optimized Version with Local Highlight.js
// Uses composition with PanelUIMessages and PanelUIFindings for tab-specific rendering
const uiLog = FransyfoxLogger.scoped('panel-ui');

type HighlightRules = Record<string, string[]>;
type ListenerFocusHandler = (listener: ListenerRecord) => void;
type RefreshHandler = () => void | Promise<void>;
type CopyFeedbackButton = HTMLButtonElement & { _copyFeedbackTimer?: ReturnType<typeof setTimeout> | null };
type MessageDisplayState = {
    emptyReason: 'none' | 'navigation' | 'manual' | 'eviction' | 'restored';
    restored: boolean;
    maxEvents: number;
    droppedCount?: number;
};

interface PanelStorageLike {
    syntaxHighlightEnabled: boolean;
    prettifyEnabled: boolean;
    expandThreshold: number;
    maxLines: number;
    codeFontSize: number;
    highlightRules: HighlightRules;
    extractJsUrlFromStack: (stack?: string, fullstack?: string[]) => string | null;
    isListenerBlocked: (listener: ListenerRecord) => { type: 'listener' | 'url' | 'regex'; value: string } | null;
    removeFromBlocklist: (type: 'listener' | 'url', value: string) => void;
    addToBlocklist: (type: 'listener' | 'url', value: string) => void;
}

interface PanelUIMessagesLike {
    displayMessages: (
        messages: unknown[],
        currentUrl: string,
        onRefresh: RefreshHandler,
        preserveScroll: boolean,
        state?: MessageDisplayState
    ) => void;
    toggleAllMessagesExpanded: () => boolean;
    setAllMessagesExpanded: (expanded: boolean) => void;
    areAllMessagesExpanded: () => boolean;
    focusMessage: (messageId: number) => boolean;
}

interface PanelUIFindingsLike {
    currentTabId: number | null;
    setListenerFocusHandler: (handler: ListenerFocusHandler) => void;
    displayFindings: (listeners: ListenerRecord[], currentUrl: string, preserveScroll: boolean, filters: FindingsFilter | null) => void;
}

interface FindingRule {
    id?: string;
    title?: string;
    description?: string;
    severity?: string;
}

interface FindingWithDetails extends Finding {
    details?: string;
}

interface FindingEntry {
    listener: ListenerRecord;
    finding: FindingWithDetails;
    rule: FindingRule | null;
}

interface FindingsFilter {
    query?: string;
    severity?: string;
    listenerKey?: string | null;
}

interface HighlightTerm {
    term: string;
    color: string;
}

class PanelUI {
    storage: PanelStorageLike;
    currentTabId: number | null;
    showBlockedOnly: boolean;
    prettifyCache: Map<string, string>;
    maxPrettifySize: number;
    maxCacheSize: number;
    onShowFindings: ListenerFocusHandler | null;
    onFocusListener: ListenerFocusHandler | null;
    URL_REGEX: RegExp;
    LINE_ENDING_REGEX: RegExp;
    messagesRenderer: PanelUIMessagesLike;
    findingsRenderer: PanelUIFindingsLike;
    highlightJsAvailable: boolean;
    // Cache of fully-built listener elements keyed by renderKey. Avoids
    // re-running highlight.js + custom highlight passes for unchanged
    // listeners on every refresh (listener bursts during page load).
    listenerElementCache: Map<string, HTMLElement>;
    maxListenerElementCache: number;
    // Bumped whenever highlight rules / syntax / font settings change, so
    // cached elements built under the old settings are not reused.
    highlightRulesVersion: number;
    constructor(storage: PanelStorageLike) {
        this.storage = storage;
        this.currentTabId = null;
        this.showBlockedOnly = false;
        this.prettifyCache = new Map();
        this.maxPrettifySize = 10000;
        this.maxCacheSize = 100;
        this.onShowFindings = null;
        this.onFocusListener = null;
        this.URL_REGEX = /\(https?:\/\/[^)]+\)/g;
        this.LINE_ENDING_REGEX = /:\d+:\d+$|:\d+$/;
        this.listenerElementCache = new Map<string, HTMLElement>();
        this.maxListenerElementCache = 300;
        this.highlightRulesVersion = 0;
        // Composed renderers for tab-specific display
        this.messagesRenderer = new (globalThis as unknown as { PanelUIMessages: new (storage: PanelStorageLike) => PanelUIMessagesLike }).PanelUIMessages(storage);
        this.findingsRenderer = new (globalThis as unknown as { PanelUIFindings: new (storage: PanelStorageLike) => PanelUIFindingsLike }).PanelUIFindings(storage);
        this.highlightJsAvailable = false;
        this.initHighlightJs();
    }
    setFindingsHandler(handler: ListenerFocusHandler) {
        this.onShowFindings = handler;
    }
    setListenerFocusHandler(handler: ListenerFocusHandler) {
        this.onFocusListener = handler;
        // Also set on composed renderers
        this.findingsRenderer.setListenerFocusHandler(handler);
    }
    getListenerFindings(listener: ListenerRecord | null | undefined): FindingWithDetails[] {
        if (!listener)
            return [];
        if (Array.isArray(listener.findings)) {
            return listener.findings;
        }
        const hasRules = globalThis.FransyfoxFindings && FransyfoxFindings.evaluateListener;
        const rulesVersion = globalThis.FransyfoxFindings ? FransyfoxFindings.version : null;
        if (listener.findingsVersion && rulesVersion && listener.findingsVersion === rulesVersion) {
            return [];
        }
        if (!hasRules)
            return [];
        const result = FransyfoxFindings.evaluateListener(listener) || { findings: [], errors: [] };
        const findings = result.findings || [];
        listener.findings = findings;
        if (rulesVersion) {
            listener.findingsVersion = rulesVersion;
        }
        return findings;
    }
    initHighlightJs() {
        if (typeof hljs !== 'undefined') {
            uiLog.info('Fransyfox: Local highlight.js is available');
            this.highlightJsAvailable = true;
            hljs.configure({
                languages: ['javascript', 'js'],
                ignoreUnescapedHTML: true
            });
        }
        else {
            uiLog.error('Fransyfox: Local highlight.js not found!');
            this.highlightJsAvailable = false;
        }
    }
    applySyntaxHighlighting(codeElement: HTMLElement, code: string) {
        if (!this.highlightJsAvailable || !this.storage.syntaxHighlightEnabled) {
            return false;
        }
        try {
            codeElement.className = codeElement.className.replace(/hljs[^\s]*/g, '').trim();
            codeElement.textContent = code;
            hljs.highlightElement(codeElement);
            return true;
        }
        catch (error) {
            uiLog.error('Fransyfox: Error applying syntax highlighting:', error);
            return false;
        }
    }
    escapeRegex(value: string) {
        return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
    formatUrl(url: string) {
        try {
            const urlObj = new URL(url);
            return urlObj.hostname + urlObj.pathname;
        }
        catch {
            return url || 'Unknown URL';
        }
    }
    formatUrlForDisplay(url: string) {
        try {
            const urlObj = new URL(url);
            const displayUrl = urlObj.hostname + urlObj.pathname;
            return displayUrl.length > 40 ? displayUrl.substring(0, 37) + '...' : displayUrl;
        }
        catch {
            return url || 'Unknown URL';
        }
    }
    extractLineColumnFromStack(stack: string | undefined, fullstack?: string[]) {
        // Search fullstack for the first line containing an https:// URL
        // to get line:column from the actual source, not the extension frame
        const lines = fullstack || (stack ? [stack] : []);
        for (const line of lines) {
            if (typeof line !== 'string') continue;
            if (!/https?:\/\//.test(line)) continue;
            const match = line.match(/:(\d+):(\d+)\)?$/);
            if (match) return { line: match[1], column: match[2] };
        }
        return null;
    }
    prettifyJavaScript(code: string): string {
        if (!code || typeof code !== 'string')
            return code;
        if (code.length > this.maxPrettifySize) {
            return code;
        }
        if (this.prettifyCache.has(code)) {
            return this.prettifyCache.get(code) || code;
        }
        if (this.prettifyCache.size >= this.maxCacheSize) {
            const firstKey = this.prettifyCache.keys().next().value;
            if (typeof firstKey === 'string') {
                this.prettifyCache.delete(firstKey);
            }
        }
        const result = this.prettifyJavaScriptCore(code);
        this.prettifyCache.set(code, result);
        return result;
    }
    prettifyJavaScriptCore(code: string) {
        let indentLevel = 0;
        const indentString = '    ';
        let inString = false;
        let stringChar = '';
        const lines: string[] = [];
        let currentLine = '';
        const chars = Array.from(code);
        const length = chars.length;
        for (let i = 0; i < length; i++) {
            const char = chars[i];
            const nextChar = chars[i + 1];
            const prevChar = chars[i - 1];
            if ((char === '"' || char === "'" || char === '`') && prevChar !== '\\') {
                if (!inString) {
                    inString = true;
                    stringChar = char;
                }
                else if (char === stringChar) {
                    inString = false;
                    stringChar = '';
                }
                currentLine += char;
                continue;
            }
            if (inString) {
                currentLine += char;
                continue;
            }
            switch (char) {
                case '{':
                    currentLine += char;
                    if (nextChar !== '}') {
                        lines.push(indentString.repeat(indentLevel) + currentLine.trim());
                        currentLine = '';
                        indentLevel++;
                    }
                    break;
                case '}':
                    if (currentLine.trim()) {
                        lines.push(indentString.repeat(indentLevel) + currentLine.trim());
                        currentLine = '';
                    }
                    indentLevel = Math.max(0, indentLevel - 1);
                    currentLine += char;
                    if (nextChar && nextChar !== ',' && nextChar !== ';' && nextChar !== ')' && nextChar !== '}') {
                        lines.push(indentString.repeat(indentLevel) + currentLine.trim());
                        currentLine = '';
                    }
                    break;
                case ';':
                    currentLine += char;
                    if (nextChar && nextChar !== ' ' && nextChar !== '\n' && nextChar !== '\r') {
                        lines.push(indentString.repeat(indentLevel) + currentLine.trim());
                        currentLine = '';
                    }
                    break;
                case '\n':
                case '\r':
                    if (currentLine.trim()) {
                        lines.push(indentString.repeat(indentLevel) + currentLine.trim());
                        currentLine = '';
                    }
                    break;
                default:
                    currentLine += char;
                    break;
            }
        }
        if (currentLine.trim()) {
            lines.push(indentString.repeat(indentLevel) + currentLine.trim());
        }
        return lines.filter((line: string) => line.trim() !== '').join('\n');
    }
    clearPrettifyCache() {
        this.prettifyCache.clear();
        // Prettified source feeds element rendering; cached elements are stale
        this.highlightRulesVersion++;
        this.invalidateListenerElementCache();
    }
    htmlDecode(text: string) {
        const textarea = document.createElement('textarea');
        textarea.innerHTML = text;
        return textarea.value;
    }
    htmlEscape(text: string) {
        return text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }
    parseHighlightText(text: string): HighlightRules {
        const rules: HighlightRules = {};
        const lines = text.split('\n');
        let currentColor: string | null = null;
        for (const line of lines) {
            const trimmedLine = line.trim();
            if (!trimmedLine)
                continue;
            const colorMatch = trimmedLine.match(/^\[(\w+)\]$/);
            if (colorMatch) {
                currentColor = colorMatch[1].toLowerCase();
                if (!rules[currentColor]) {
                    rules[currentColor] = [];
                }
                continue;
            }
            if (currentColor && trimmedLine) {
                const terms = trimmedLine.split(',').map((term: string) => term.trim()).filter((term: string) => term.length > 0);
                rules[currentColor].push(...terms);
            }
        }
        uiLog.info('Fransyfox: Parsed highlight rules:', rules);
        return rules;
    }
    applyHighlighting(text: string, rules: HighlightRules) {
        if (!rules || Object.keys(rules).length === 0) {
            return this.htmlEscape(text);
        }
        const cleanText = this.htmlDecode(text);
        const allTerms: HighlightTerm[] = [];
        for (const [color, terms] of Object.entries(rules)) {
            for (const term of terms) {
                if (term && term.trim()) {
                    allTerms.push({ term: term.trim(), color });
                }
            }
        }
        allTerms.sort((a: HighlightTerm, b: HighlightTerm) => b.term.length - a.term.length);
        let result = cleanText;
        const replacements: Array<{ placeholder: string; html: string }> = [];
        allTerms.forEach((item: HighlightTerm, index: number) => {
            const placeholder = `__PLACEHOLDER_${index}__`;
            result = result.split(item.term).join(placeholder);
            replacements.push({
                placeholder: placeholder,
                html: `<span class="highlight-${item.color} custom-highlight">${this.htmlEscape(item.term)}</span>`
            });
        });
        result = this.htmlEscape(result);
        replacements.forEach(({ placeholder, html }: { placeholder: string; html: string }) => {
            result = result.split(this.htmlEscape(placeholder)).join(html);
        });
        return result;
    }
    addExpandFunctionality(codeBlock: HTMLElement) {
        const existingIndicator = codeBlock.querySelector('.expand-indicator');
        if (existingIndicator) {
            existingIndicator.remove();
        }
        codeBlock.onclick = null;
        const expandIndicator = document.createElement('div');
        expandIndicator.className = 'expand-indicator';
        expandIndicator.textContent = 'expand';
        codeBlock.appendChild(expandIndicator);
        codeBlock.onclick = (e: MouseEvent) => {
            const indicator = codeBlock.querySelector('.expand-indicator');
            if (e.target === indicator && !codeBlock.classList.contains('truncated') && indicator instanceof HTMLElement) {
                codeBlock.classList.add('truncated');
                indicator.textContent = 'expand';
            }
            else if (codeBlock.classList.contains('truncated') && indicator instanceof HTMLElement) {
                codeBlock.classList.remove('truncated');
                indicator.textContent = 'collapse';
            }
        };
    }
    shouldTruncateCode(originalCode: string, displayCode: string) {
        return displayCode.length > this.storage.expandThreshold ||
            displayCode.split('\n').length > this.storage.maxLines;
    }
    getFindingsEntriesForListener(listener: ListenerRecord, findingsByKey: Map<string, FindingEntry[]> | null = null): FindingEntry[] {
        const entries: FindingEntry[] = [];
        const findings = this.getListenerFindings(listener);
        if (findings.length > 0) {
            findings.forEach((finding: FindingWithDetails | string) => {
                const findingId = typeof finding === 'string' ? finding : (finding && finding.id);
                if (!findingId)
                    return;
                const rule = globalThis.FransyfoxFindings && FransyfoxFindings.getRuleById
                    ? FransyfoxFindings.getRuleById(findingId)
                    : null;
                entries.push({
                    finding: typeof finding === 'string' ? { id: findingId } : finding,
                    rule: rule,
                    listener
                });
            });
            return entries;
        }
        if (!findingsByKey)
            return entries;
        const key = this.getListenerKeyForFilter(listener);
        const mapped = findingsByKey.get(key);
        if (Array.isArray(mapped)) {
            return mapped;
        }
        return entries;
    }
    // Render key capturing everything that affects a listener element's
    // markup (but NOT its display index, which is patched on reuse).
    getListenerRenderKey(listener: ListenerRecord, findingsByKey: Map<string, FindingEntry[]> | null): string | null {
        const key = this.getListenerKeyForFilter(listener);
        if (!key) {
            return null;
        }
        const blockInfo = this.storage.isListenerBlocked(listener);
        const blockTag = blockInfo ? `${blockInfo.type}:${blockInfo.value}` : 'none';
        const findingsCount = this.getFindingsEntriesForListener(listener, findingsByKey).length;
        return [
            key,
            this.storage.prettifyEnabled ? 1 : 0,
            this.storage.syntaxHighlightEnabled ? 1 : 0,
            this.highlightRulesVersion,
            this.storage.codeFontSize,
            this.showBlockedOnly ? 1 : 0,
            blockTag,
            findingsCount,
            listener.stale ? 1 : 0
        ].join('::');
    }
    // Reuse a cached element for unchanged listeners; only patches the index
    // number and clears transient state. Cache misses build a fresh element
    // (running highlight.js + custom highlighting once per unique render key).
    getOrCreateListenerElement(listener: ListenerRecord, index: number, onRefresh: RefreshHandler, findingsByKey: Map<string, FindingEntry[]> | null): HTMLElement {
        const renderKey = this.getListenerRenderKey(listener, findingsByKey);
        if (renderKey) {
            const cached = this.listenerElementCache.get(renderKey);
            if (cached) {
                const indexNode = cached.querySelector('.index-number');
                if (indexNode) {
                    indexNode.textContent = String(index);
                }
                cached.classList.remove('focused');
                cached.querySelectorAll('.listener-dropdown.show').forEach((d) => d.classList.remove('show'));
                return cached;
            }
        }
        const element = this.createListenerElement(listener, index, onRefresh, findingsByKey);
        if (renderKey) {
            this.listenerElementCache.set(renderKey, element);
            this.trimListenerElementCache();
        }
        return element;
    }
    trimListenerElementCache() {
        if (this.listenerElementCache.size <= this.maxListenerElementCache) {
            return;
        }
        // Drop oldest disconnected entries first (insertion order = iteration order)
        for (const [key, element] of this.listenerElementCache) {
            if (this.listenerElementCache.size <= this.maxListenerElementCache) {
                break;
            }
            if (!element.isConnected) {
                this.listenerElementCache.delete(key);
            }
        }
        // If still over budget, evict oldest regardless
        while (this.listenerElementCache.size > this.maxListenerElementCache) {
            const oldest = this.listenerElementCache.keys().next().value;
            if (oldest === undefined) {
                break;
            }
            this.listenerElementCache.delete(oldest);
        }
    }
    invalidateListenerElementCache() {
        this.listenerElementCache.clear();
    }
    createListenerElement(listener: ListenerRecord, index: number, onRefresh: RefreshHandler, findingsByKey: Map<string, FindingEntry[]> | null = null) {
        const item = document.createElement('div');
        item.className = 'listener-item';
        if (listener.stale) {
            item.classList.add('stale');
        }
        item.dataset.listenerKey = this.getListenerKeyForFilter(listener);
        const header = document.createElement('div');
        header.className = 'listener-header';
        const listenerInfo = document.createElement('div');
        listenerInfo.className = 'listener-info';
        const indexNumber = document.createElement('div');
        indexNumber.className = 'index-number';
        indexNumber.textContent = String(index);
        const domainName = document.createElement('div');
        domainName.className = 'domain-name';
        const domain = listener.domain || 'unknown';
        domainName.textContent = domain;
        if (domain.length > 20) {
            domainName.title = domain;
            domainName.style.cursor = 'help';
        }
        const windowInfo = document.createElement('div');
        windowInfo.className = 'window-info';
        let windowText = (listener.window ? listener.window + ' ' : '') +
            (listener.hops && listener.hops.length ? listener.hops : 'direct');
        windowText = windowText.replace(/%7B[^}]*%7D\s*/g, '').trim();
        if (!windowText || windowText === '') {
            windowText = 'direct';
        }
        windowInfo.textContent = windowText;
        if (windowText.length > 25) {
            windowInfo.title = windowText;
            windowInfo.style.cursor = 'help';
        }
        listenerInfo.appendChild(indexNumber);
        listenerInfo.appendChild(domainName);
        listenerInfo.appendChild(windowInfo);
        const listenerActions = document.createElement('div');
        listenerActions.className = 'listener-actions';
        const findingsEntries = this.getFindingsEntriesForListener(listener, findingsByKey);
        if (findingsEntries.length > 0) {
            const warningBtn = document.createElement('button');
            warningBtn.className = 'warning-btn';
            warningBtn.innerHTML = '&#9888;';
            const titles = findingsEntries.map((entry: FindingEntry) => {
                const rule = entry.rule;
                if (rule && rule.title)
                    return rule.title;
                const finding = entry.finding || {};
                return finding.id || null;
            }).filter(Boolean);
            const titleText = titles.length ? titles.join(', ') : 'View findings';
            warningBtn.title = `Findings (${findingsEntries.length}): ${titleText}`;
            warningBtn.onclick = (e: MouseEvent) => {
                e.stopPropagation();
                if (typeof this.onShowFindings === 'function') {
                    this.onShowFindings(listener);
                }
            };
            listenerActions.appendChild(warningBtn);
        }
        // Kebab dropdown menu for listener actions
        const kebabBtn = document.createElement('button');
        kebabBtn.className = 'listener-kebab-btn';
        kebabBtn.type = 'button';
        kebabBtn.textContent = '\u22EE';
        kebabBtn.title = 'Actions';

        const dropdown = document.createElement('div');
        dropdown.className = 'listener-dropdown';

        // Copy code item (always present)
        const copyItem = document.createElement('button');
        copyItem.className = 'listener-dropdown-item';
        copyItem.type = 'button';
        copyItem.textContent = 'Copy code';
        copyItem.addEventListener('click', (e: MouseEvent) => {
            e.stopPropagation();
            dropdown.classList.remove('show');
            const rawCode = listener.listener || '';
            void this.copyTextWithFeedback(rawCode, kebabBtn);
        });
        dropdown.appendChild(copyItem);

        const blockInfo = this.storage.isListenerBlocked(listener);
        if (blockInfo && this.showBlockedOnly) {
            if (blockInfo.type === 'listener') {
                const unblockItem = document.createElement('button');
                unblockItem.className = 'listener-dropdown-item';
                unblockItem.type = 'button';
                unblockItem.textContent = 'Unblock';
                unblockItem.addEventListener('click', (e: MouseEvent) => {
                    e.stopPropagation();
                    dropdown.classList.remove('show');
                    this.storage.removeFromBlocklist('listener', blockInfo.value);
                    void onRefresh();
                });
                dropdown.appendChild(unblockItem);
            }
            else if (blockInfo.type === 'url') {
                const unblockUrlItem = document.createElement('button');
                unblockUrlItem.className = 'listener-dropdown-item';
                unblockUrlItem.type = 'button';
                unblockUrlItem.textContent = 'Unblock URL';
                unblockUrlItem.addEventListener('click', (e: MouseEvent) => {
                    e.stopPropagation();
                    dropdown.classList.remove('show');
                    this.storage.removeFromBlocklist('url', blockInfo.value);
                    void onRefresh();
                });
                dropdown.appendChild(unblockUrlItem);
            }
            else if (blockInfo.type === 'regex') {
                const regexItem = document.createElement('button');
                regexItem.className = 'listener-dropdown-item';
                regexItem.type = 'button';
                regexItem.textContent = 'Regex Blocked';
                regexItem.title = `Blocked by regex: ${blockInfo.value}`;
                regexItem.disabled = true;
                dropdown.appendChild(regexItem);
            }
        }
        else if (!blockInfo && !this.showBlockedOnly) {
            const blockItem = document.createElement('button');
            blockItem.className = 'listener-dropdown-item';
            blockItem.type = 'button';
            blockItem.textContent = 'Block';
            blockItem.addEventListener('click', (e: MouseEvent) => {
                e.stopPropagation();
                dropdown.classList.remove('show');
                this.storage.addToBlocklist('listener', listener.listener);
                void onRefresh();
            });
            dropdown.appendChild(blockItem);

            const jsUrl = this.storage.extractJsUrlFromStack(listener.stack, listener.fullstack);
            const blockUrlItem = document.createElement('button');
            blockUrlItem.className = 'listener-dropdown-item';
            blockUrlItem.type = 'button';
            blockUrlItem.textContent = 'Block URL';
            if (jsUrl && jsUrl.length > 0) {
                blockUrlItem.title = `Block all listeners from: ${this.formatUrlForDisplay(jsUrl)}`;
                blockUrlItem.addEventListener('click', (e: MouseEvent) => {
                    e.stopPropagation();
                    dropdown.classList.remove('show');
                    this.storage.addToBlocklist('url', jsUrl);
                    void onRefresh();
                });
            }
            else {
                blockUrlItem.title = 'No JavaScript file detected in stack trace';
                blockUrlItem.disabled = true;
            }
            dropdown.appendChild(blockUrlItem);
        }

        kebabBtn.addEventListener('click', (e: MouseEvent) => {
            e.stopPropagation();
            // Close any other open dropdowns
            document.querySelectorAll('.listener-dropdown.show, .message-dropdown.show').forEach(d => {
                if (d !== dropdown) d.classList.remove('show');
            });
            dropdown.classList.toggle('show');
        });

        listenerActions.appendChild(kebabBtn);
        listenerActions.appendChild(dropdown);
        header.appendChild(listenerInfo);
        header.appendChild(listenerActions);
        const stackSection = document.createElement('div');
        stackSection.className = 'stack-section';
        const stackTrace = document.createElement('div');
        stackTrace.className = 'stack-trace';
        // Show the first external (non-extension) stack frame instead of the
        // extension's own patchedAddEventListener frame
        let displayStack = listener.stack || 'Unknown stack';
        if (listener.fullstack) {
            const externalFrame = listener.fullstack.find(
                (line: string) => typeof line === 'string' && /https?:\/\//.test(line)
            );
            if (externalFrame) {
                displayStack = externalFrame;
            }
            stackTrace.title = listener.fullstack.join('\n\n');
        }
        // Strip URL portion from stack frame to avoid duplication with the
        // clickable link rendered in sourceRow below.
        // Handles both "at fn (https://...)" and bare "at https://..." formats.
        displayStack = displayStack
            .replace(/\s*\(https?:\/\/[^)]*\)\s*$/, '')
            .replace(/\s*https?:\/\/\S+\s*$/, '')
            .trim();
        // Hide if nothing meaningful remains (e.g. bare "at" from anonymous frames)
        if (displayStack && displayStack !== 'at') {
            stackTrace.textContent = displayStack;
        } else {
            stackTrace.style.display = 'none';
        }
        stackSection.appendChild(stackTrace);
        const sourceRow = document.createElement('div');
        sourceRow.className = 'stack-trace';
        const jsUrl = this.storage.extractJsUrlFromStack(listener.stack, listener.fullstack);
        const lineColumn = this.extractLineColumnFromStack(listener.stack, listener.fullstack);
        if (jsUrl) {
            const link = document.createElement('a');
            link.href = jsUrl;
            link.textContent = jsUrl;
            link.target = '_blank';
            link.rel = 'noreferrer';
            link.style.color = '#2563eb';
            link.style.textDecoration = 'none';
            link.addEventListener('click', (e) => {
                e.preventDefault();
                const line = lineColumn ? parseInt(lineColumn.line, 10) : 1;
                const column = lineColumn ? parseInt(lineColumn.column, 10) : 0;
                const openInTab = () => chrome.tabs.create({ url: jsUrl });
                if (this.currentTabId) {
                    chrome.runtime.sendMessage({
                        action: 'openInDevtools',
                        url: jsUrl,
                        line,
                        column,
                        tabId: this.currentTabId
                    }).then((response: unknown) => {
                        if (!response || !(response as Record<string, unknown>).success) {
                            void openInTab();
                        }
                    }).catch(() => {
                        void openInTab();
                    });
                } else {
                    void openInTab();
                }
            });
            sourceRow.appendChild(link);
            if (lineColumn) {
                const lineText = document.createElement('span');
                lineText.textContent = `:${lineColumn.line}:${lineColumn.column}`;
                lineText.style.color = '#6b7280';
                lineText.style.marginLeft = '6px';
                sourceRow.appendChild(lineText);
            }
        }
        else {
            sourceRow.textContent = 'Source: unknown';
        }
        stackSection.appendChild(sourceRow);
        const codeSection = document.createElement('div');
        codeSection.className = 'code-section';
        const codeBlock = document.createElement('div');
        codeBlock.className = 'code-block';
        codeBlock.style.fontSize = `${this.storage.codeFontSize}px`;
        const originalCode = listener.listener || 'function() { /* code not available */ }';
        let displayCode = originalCode;
        if (this.storage.prettifyEnabled) {
            displayCode = this.prettifyJavaScript(originalCode);
        }
        codeBlock.setAttribute('data-original-text', originalCode);
        // Apply highlighting in the correct order to prevent interference.
        // For very large sources only a preview is highlighted; the full text
        // is stored and revealed on demand (avoids hljs over 100KB+ blobs).
        this.renderCodeBlockContent(codeBlock, codeSection, displayCode);
        if (this.shouldTruncateCode(originalCode, displayCode)) {
            codeBlock.classList.add('truncated');
            this.addExpandFunctionality(codeBlock);
        }
        codeSection.appendChild(codeBlock);
        this.appendFullSourceExpander(codeBlock, codeSection, displayCode);
        item.appendChild(header);
        item.appendChild(stackSection);
        item.appendChild(codeSection);
        return item;
    }
    // Sources longer than this are not fully syntax-highlighted on render;
    // only a preview is highlighted and the rest is revealed on demand.
    readonly maxHighlightChars = 10000;
    // Highlight a preview when the source is very large, else the whole thing.
    renderCodeBlockContent(codeBlock: HTMLElement, _codeSection: HTMLElement, displayCode: string) {
        if (displayCode.length <= this.maxHighlightChars) {
            codeBlock.removeAttribute('data-preview-truncated');
            this.applyAllHighlighting(codeBlock, displayCode);
            return;
        }
        codeBlock.setAttribute('data-preview-truncated', 'true');
        this.applyAllHighlighting(codeBlock, displayCode.slice(0, this.maxHighlightChars));
    }
    // Add a "Show full source" control after a preview-truncated code block.
    // Revealing renders the full text as plain text to stay responsive on
    // very large sources (full data is always preserved in data-original-text).
    appendFullSourceExpander(codeBlock: HTMLElement, codeSection: HTMLElement, displayCode: string) {
        if (codeBlock.getAttribute('data-preview-truncated') !== 'true') {
            return;
        }
        const expander = document.createElement('button');
        expander.type = 'button';
        expander.className = 'code-full-source-btn';
        expander.style.cssText =
            'margin-top:4px;font-size:11px;color:#2563eb;background:none;border:none;cursor:pointer;padding:2px 0;';
        expander.textContent = `Show full source (${displayCode.length} chars)`;
        expander.addEventListener('click', (e: MouseEvent) => {
            e.stopPropagation();
            codeBlock.classList.remove('truncated');
            codeBlock.textContent = displayCode;
            codeBlock.removeAttribute('data-preview-truncated');
            expander.remove();
        });
        codeSection.appendChild(expander);
    }
    // NEW METHOD: Apply all highlighting in the correct order
    applyAllHighlighting(codeBlock: HTMLElement, displayCode: string) {
        const hasCustomRules = this.storage.highlightRules && Object.keys(this.storage.highlightRules).length > 0;
        const hasSyntaxHighlighting = this.storage.syntaxHighlightEnabled && this.highlightJsAvailable;
        uiLog.info('Fransyfox: Applying highlighting - Custom rules:', hasCustomRules, 'Syntax highlighting:', hasSyntaxHighlighting);
        if (!hasCustomRules && !hasSyntaxHighlighting) {
            // No highlighting at all
            codeBlock.textContent = displayCode;
            return;
        }
        if (!hasCustomRules && hasSyntaxHighlighting) {
            // Only syntax highlighting
            this.applySyntaxHighlighting(codeBlock, displayCode);
            return;
        }
        if (hasCustomRules && !hasSyntaxHighlighting) {
            // Only custom highlighting
            codeBlock.innerHTML = this.applyHighlighting(displayCode, this.storage.highlightRules);
            return;
        }
        // Both custom and syntax highlighting - this is the tricky case
        // Strategy: Apply custom highlighting first with special markers, then syntax highlighting, then convert markers
        uiLog.info('Fransyfox: Applying both custom and syntax highlighting');
        // Step 1: Apply custom highlighting with placeholders
        const customHighlighted = this.applyCustomHighlightingWithPlaceholders(displayCode, this.storage.highlightRules);
        // Step 2: Apply syntax highlighting (this will process the placeholders as regular text)
        codeBlock.textContent = customHighlighted;
        this.applySyntaxHighlighting(codeBlock, customHighlighted);
        // Step 3: Convert placeholders back to actual highlight spans
        const finalHtml = this.convertPlaceholdersToHighlights(codeBlock.innerHTML);
        codeBlock.innerHTML = finalHtml;
    }
    // Apply custom highlighting using placeholders that survive syntax highlighting
    applyCustomHighlightingWithPlaceholders(text: string, rules: HighlightRules) {
        if (!rules || Object.keys(rules).length === 0) {
            return text;
        }
        const allTerms: HighlightTerm[] = [];
        for (const [color, terms] of Object.entries(rules)) {
            for (const term of terms) {
                if (term && term.trim()) {
                    allTerms.push({ term: term.trim(), color });
                }
            }
        }
        allTerms.sort((a: HighlightTerm, b: HighlightTerm) => b.term.length - a.term.length);
        let result = text;
        let placeholderIndex = 0;
        allTerms.forEach((item: HighlightTerm) => {
            const term = item.term;
            const color = item.color;
            const escapedTerm = this.escapeRegex(term);
            const regex = new RegExp(`\\b(${escapedTerm})\\b`, 'gi');
            result = result.replace(regex, (match: string) => {
                const placeholder = `__CUSTOM_HIGHLIGHT_${placeholderIndex}_${color}__${match}__END_CUSTOM_HIGHLIGHT_${placeholderIndex}__`;
                placeholderIndex++;
                return placeholder;
            });
        });
        return result;
    }
    // Convert placeholders back to actual highlight spans
    convertPlaceholdersToHighlights(html: string) {
        // Find all placeholders in the syntax-highlighted HTML
        const placeholderRegex = /__CUSTOM_HIGHLIGHT_(\d+)_([^_]+)__(.+?)__END_CUSTOM_HIGHLIGHT_\1__/g;
        return html.replace(placeholderRegex, (_match: string, _index: string, color: string, content: string) => {
            return `<span class="highlight-${color} custom-highlight">${content}</span>`;
        });
    }
    updateShowBlockedButton() {
        const showBlockedBtn = document.getElementById('show-blocked-btn');
        if (showBlockedBtn) {
            if (this.showBlockedOnly) {
                showBlockedBtn.classList.add('active');
                showBlockedBtn.title = 'Showing blocked listeners';
            }
            else {
                showBlockedBtn.classList.remove('active');
                showBlockedBtn.title = 'Show blocked listeners';
            }
        }
    }
    toggleShowBlocked() {
        this.showBlockedOnly = !this.showBlockedOnly;
        this.updateShowBlockedButton();
    }
    // OPTIMIZED: Better re-highlighting that preserves syntax highlighting when possible
    reHighlightCodeBlocks(forceRebuildSyntax = false) {
        // Highlight settings changed - cached elements no longer match
        this.highlightRulesVersion++;
        this.invalidateListenerElementCache();
        uiLog.info('Fransyfox: Re-highlighting all code blocks, force rebuild syntax:', forceRebuildSyntax);
        uiLog.info('Fransyfox: Current highlight rules:', this.storage.highlightRules);
        uiLog.info('Fransyfox: Syntax highlighting enabled:', this.storage.syntaxHighlightEnabled);
        document.querySelectorAll('.code-block').forEach((codeBlock: Element, index: number) => {
            if (!(codeBlock instanceof HTMLElement)) {
                return;
            }
            const originalText = codeBlock.getAttribute('data-original-text');
            if (originalText) {
                uiLog.info(`Fransyfox: Re-highlighting code block ${index + 1}`);
                const wasExpanded = !codeBlock.classList.contains('truncated');
                let displayCode = originalText;
                if (this.storage.prettifyEnabled) {
                    displayCode = this.prettifyJavaScript(originalText);
                }
                // Cap the highlighted text for very large sources (same policy
                // as initial render); a following refresh rebuilds the element
                // with the "show full source" control.
                const highlightCode = displayCode.length > this.maxHighlightChars
                    ? displayCode.slice(0, this.maxHighlightChars)
                    : displayCode;
                if (forceRebuildSyntax) {
                    // Full rebuild needed (syntax highlighting settings changed)
                    uiLog.info('Fransyfox: Full rebuild - clearing existing highlighting');
                    codeBlock.className = codeBlock.className.replace(/hljs[^\s]*/g, '').trim();
                    this.applyAllHighlighting(codeBlock, highlightCode);
                }
                else {
                    // Only custom highlighting changed - preserve syntax highlighting
                    uiLog.info('Fransyfox: Optimized rebuild - preserving syntax highlighting');
                    this.updateCustomHighlightingOnly(codeBlock, highlightCode);
                }
                // Apply font size and truncation
                codeBlock.style.fontSize = `${this.storage.codeFontSize}px`;
                if (this.shouldTruncateCode(originalText, displayCode)) {
                    codeBlock.classList.toggle('truncated', !wasExpanded);
                    this.addExpandFunctionality(codeBlock);
                }
            }
        });
        uiLog.info('Fransyfox: Re-highlighting complete');
    }
    // NEW METHOD: Update only custom highlighting without affecting syntax highlighting
    updateCustomHighlightingOnly(codeBlock: HTMLElement, displayCode: string) {
        const hasCustomRules = this.storage.highlightRules && Object.keys(this.storage.highlightRules).length > 0;
        const hasSyntaxHighlighting = this.storage.syntaxHighlightEnabled && this.highlightJsAvailable;
        // Remove existing custom highlights while preserving syntax highlighting
        this.removeExistingCustomHighlights(codeBlock);
        if (!hasCustomRules) {
            // No custom rules, we're done (syntax highlighting is preserved)
            uiLog.info('Fransyfox: No custom rules, keeping existing content');
            return;
        }
        if (hasSyntaxHighlighting && this.hasExistingSyntaxHighlighting(codeBlock)) {
            // Apply custom highlighting on top of existing syntax highlighting
            uiLog.info('Fransyfox: Applying custom highlighting on existing syntax highlighting');
            const currentHtml = codeBlock.innerHTML;
            const withCustomHighlighting = this.applyCustomHighlightingOnExistingHtml(currentHtml, this.storage.highlightRules);
            codeBlock.innerHTML = withCustomHighlighting;
        }
        else {
            // No existing syntax highlighting, apply custom highlighting on plain text
            uiLog.info('Fransyfox: Applying custom highlighting on plain text');
            codeBlock.innerHTML = this.applyHighlighting(displayCode, this.storage.highlightRules);
        }
    }
    // Remove existing custom highlights while preserving other HTML
    removeExistingCustomHighlights(codeBlock: HTMLElement) {
        // Find all existing custom highlight spans and unwrap them
        const customHighlights = codeBlock.querySelectorAll('.custom-highlight');
        customHighlights.forEach((span: Element) => {
            if (!(span instanceof HTMLElement) || !span.parentNode) {
                return;
            }
            // Move the span's contents to its parent and remove the span
            while (span.firstChild) {
                span.parentNode.insertBefore(span.firstChild, span);
            }
            span.parentNode.removeChild(span);
        });
    }
    // Check if the code block has existing syntax highlighting
    hasExistingSyntaxHighlighting(codeBlock: HTMLElement) {
        return codeBlock.querySelector('.hljs-keyword, .hljs-string, .hljs-number, .hljs-comment') !== null;
    }
    // Apply custom highlighting on existing HTML (better approach that finds specific terms)
    applyCustomHighlightingOnExistingHtml(htmlContent: string, rules: HighlightRules) {
        if (!rules || Object.keys(rules).length === 0) {
            return htmlContent;
        }
        uiLog.info('Fransyfox: Applying custom highlighting on existing HTML');
        // Get the plain text to find matches
        const tempDiv = document.createElement('div');
        tempDiv.innerHTML = htmlContent;
        const plainText = tempDiv.textContent || tempDiv.innerText || '';
        // Collect all terms with their colors
        const allTerms: HighlightTerm[] = [];
        for (const [color, terms] of Object.entries(rules)) {
            for (const term of terms) {
                if (term && term.trim()) {
                    allTerms.push({ term: term.trim(), color });
                }
            }
        }
        // Sort by length (longest first) to avoid partial matches
        allTerms.sort((a: HighlightTerm, b: HighlightTerm) => b.term.length - a.term.length);
        if (allTerms.length === 0) {
            return htmlContent;
        }
        let result = htmlContent;
        // For each term that exists in the plain text, apply highlighting
        allTerms.forEach((item: HighlightTerm) => {
            const term = item.term;
            const color = item.color;
            const escapedTerm = this.escapeRegex(term);
            const plainTextRegex = new RegExp(`\\b${escapedTerm}\\b`, 'gi');
            if (plainTextRegex.test(plainText)) {
                uiLog.info(`Fransyfox: Highlighting term "${term}" in existing HTML`);
                // Use a more sophisticated approach for existing HTML
                result = this.wrapTermInExistingHtml(result, term, color);
            }
        });
        return result;
    }
    // Wrap a specific term in existing HTML with highlight spans
    wrapTermInExistingHtml(htmlContent: string, term: string, color: string) {
        // Strategy: Use a placeholder approach on the existing HTML
        const placeholder = `___TEMP_HIGHLIGHT_${color}___`;
        const endPlaceholder = `___END_TEMP_HIGHLIGHT_${color}___`;
        // First, try simple term replacement
        const escapedTerm = this.escapeRegex(term);
        const simpleRegex = new RegExp(`\\b(${escapedTerm})\\b`, 'gi');
        // Replace in text content while preserving HTML structure
        let result = htmlContent;
        // Split HTML into segments and only process text segments
        const segments = result.split(/(<[^>]+>)/);
        for (let i = 0; i < segments.length; i++) {
            const segment = segments[i];
            // Only process text segments (not HTML tags)
            if (!segment.startsWith('<') && segment.trim() !== '') {
                // Apply highlighting to this text segment
                segments[i] = segment.replace(simpleRegex, `${placeholder}$1${endPlaceholder}`);
            }
        }
        result = segments.join('');
        // Convert placeholders to actual highlight spans
        const finalRegex = new RegExp(`${this.escapeRegex(placeholder)}(.*?)${this.escapeRegex(endPlaceholder)}`, 'gi');
        result = result.replace(finalRegex, `<span class="highlight-${color} custom-highlight">$1</span>`);
        return result;
    }
    displayListeners(listeners: ListenerRecord[], currentUrl: string, onRefresh: RefreshHandler, preserveScroll = false, onShowFindings: ListenerFocusHandler | null = null, focusListenerKey: string | null = null, reverseNumbering = false) {
        try {
            if (typeof onShowFindings === 'function') {
                this.onShowFindings = onShowFindings;
            }
            requestAnimationFrame(() => {
                const findingsByKey = new Map<string, FindingEntry[]>();
                const allFindings = this.buildFindingsList(listeners, true);
                for (const entry of allFindings) {
                    const key = this.getListenerKeyForFilter(entry.listener);
                    if (!key)
                        continue;
                    if (!findingsByKey.has(key)) {
                        findingsByKey.set(key, []);
                    }
                    const listForKey = findingsByKey.get(key);
                    if (listForKey) {
                        listForKey.push(entry);
                    }
                }
                let savedScrollTop = 0;
                const contentElement = document.querySelector<HTMLElement>('.content');
                if (preserveScroll && contentElement) {
                    savedScrollTop = contentElement.scrollTop;
                }
                const headerElement = document.getElementById('h');
                if (headerElement) {
                    headerElement.textContent = this.formatUrl(currentUrl);
                }
                const filteredListeners = listeners;
                const countElement = document.getElementById('listener-count');
                const statusElement = document.getElementById('status-badge');
                if (countElement) {
                    countElement.textContent = '';
                }
                if (statusElement) {
                    if (this.showBlockedOnly) {
                        statusElement.title = 'Blocked';
                        statusElement.className = 'status-dot inactive';
                    }
                    else {
                        if (filteredListeners && filteredListeners.length > 0) {
                            statusElement.title = 'Active';
                            statusElement.className = 'status-dot';
                        }
                        else {
                            statusElement.title = 'Idle';
                            statusElement.className = 'status-dot inactive';
                        }
                    }
                }
                const container = document.getElementById('x');
                if (!container)
                    return;
                if (filteredListeners && filteredListeners.length > 0) {
                    const fragment = document.createDocumentFragment();
                    for (let i = 0; i < filteredListeners.length; i++) {
                        const listener = filteredListeners[i];
                        const displayIndex = reverseNumbering ? (filteredListeners.length - i) : (i + 1);
                        const listenerElement = this.getOrCreateListenerElement(listener, displayIndex, onRefresh, findingsByKey);
                        fragment.appendChild(listenerElement);
                    }
                    container.replaceChildren(fragment);
                    if (focusListenerKey) {
                        const items = container.querySelectorAll('.listener-item');
                        items.forEach((item: Element) => {
                            if (!(item instanceof HTMLElement)) {
                                return;
                            }
                            if (item.dataset.listenerKey === focusListenerKey) {
                                item.classList.add('focused');
                                item.scrollIntoView({ behavior: 'smooth', block: 'center' });
                                setTimeout(() => {
                                    item.classList.remove('focused');
                                }, 2000);
                            }
                        });
                    }
                }
                else {
                    const emptyState = document.createElement('div');
                    emptyState.className = 'empty-state';
                    emptyState.innerHTML = `
                        <div class="empty-title">No listeners to display</div>
                        <div class="empty-description">
                            No listeners match the current filters.
                            Try adjusting your search, URL filter, or toggle blocked view.
                        </div>
                    `;
                    container.replaceChildren(emptyState);
                }
                if (preserveScroll && contentElement && savedScrollTop > 0) {
                    setTimeout(() => {
                        contentElement.scrollTop = savedScrollTop;
                    }, 0);
                }
            });
        }
        catch (error) {
            uiLog.error('Fransyfox: Error building listener list:', error);
        }
    }
    buildFindingsList(listeners: ListenerRecord[], excludeBlocked = false): FindingEntry[] {
        const results: FindingEntry[] = [];
        if (!Array.isArray(listeners))
            return results;
        for (const listener of listeners) {
            if (!listener) {
                continue;
            }
            if (excludeBlocked && this.storage && this.storage.isListenerBlocked(listener)) {
                continue;
            }
            const findings = this.getListenerFindings(listener);
            if (!findings.length) {
                continue;
            }
            for (const finding of findings) {
                const findingId = typeof finding === 'string' ? finding : (finding && finding.id);
                if (!findingId) {
                    continue;
                }
                const rule = globalThis.FransyfoxFindings && FransyfoxFindings.getRuleById
                    ? FransyfoxFindings.getRuleById(findingId)
                    : null;
                results.push({
                    listener,
                    finding: typeof finding === 'string' ? { id: finding } : finding,
                    rule: rule
                });
            }
        }
        return results;
    }
    formatListenerContext(listener: ListenerRecord) {
        const domain = listener.domain || 'unknown';
        let windowText = (listener.window ? listener.window + ' ' : '') +
            (listener.hops && listener.hops.length ? listener.hops : 'direct');
        windowText = windowText.replace(/%7B[^}]*%7D\s*/g, '').trim();
        if (!windowText || windowText === '') {
            windowText = 'direct';
        }
        return { domain, windowText };
    }
    getListenerKeyForFilter(listener: ListenerRecord | null | undefined) {
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
    applyFindingsFilters(findings: FindingEntry[], filters: FindingsFilter | null) {
        if (!Array.isArray(findings) || findings.length === 0)
            return [];
        const filter: FindingsFilter = filters || {};
        const query = (filter.query || '').trim().toLowerCase();
        const severity = filter.severity || 'any';
        const listenerKey = filter.listenerKey || null;
        return findings.filter((entry: FindingEntry) => {
            const rule = entry.rule || {};
            const finding = entry.finding || {};
            const listener = entry.listener || ({ listener: '' });
            const entrySeverity = rule.severity || 'medium';
            if (severity !== 'any' && entrySeverity !== severity) {
                return false;
            }
            if (listenerKey) {
                const key = this.getListenerKeyForFilter(listener);
                if (key !== listenerKey)
                    return false;
            }
            if (!query)
                return true;
            const contextText = [
                rule.id,
                rule.title,
                rule.description,
                finding.details,
                listener.domain,
                listener.window,
                listener.hops,
                listener.stack,
                listener.listener
            ].filter(Boolean).join(' ').toLowerCase();
            return contextText.includes(query);
        });
    }
    // Delegate to composed renderer for findings display
    displayFindings(listeners: ListenerRecord[], currentUrl: string, preserveScroll = false, filters: FindingsFilter | null = null) {
        this.findingsRenderer.currentTabId = this.currentTabId;
        this.findingsRenderer.displayFindings(listeners, currentUrl, preserveScroll, filters);
    }
    // Delegate to composed renderer for messages display
    displayMessages(
        messages: unknown[],
        currentUrl: string,
        onRefresh: RefreshHandler,
        preserveScroll = false,
        state?: MessageDisplayState
    ) {
        this.messagesRenderer.displayMessages(messages, currentUrl, onRefresh, preserveScroll, state);
    }
    toggleAllMessagesExpanded() {
        return this.messagesRenderer.toggleAllMessagesExpanded();
    }
    setAllMessagesExpanded(expanded: boolean) {
        this.messagesRenderer.setAllMessagesExpanded(expanded);
    }
    areAllMessagesExpanded() {
        return this.messagesRenderer.areAllMessagesExpanded();
    }
    focusMessage(messageId: number) {
        return this.messagesRenderer.focusMessage(messageId);
    }
    // Clipboard utilities - kept here for use by listeners tab and shared access
    async copyTextWithFeedback(text: string, button: CopyFeedbackButton) {
        const originalText = button.textContent;
        const originalTitle = button.title;
        const success = await this.copyToClipboard(text);
        button.textContent = success ? 'Copied' : 'Copy failed';
        button.title = success ? 'Copied to clipboard' : 'Copy failed';
        if (button._copyFeedbackTimer) {
            clearTimeout(button._copyFeedbackTimer);
        }
        button._copyFeedbackTimer = setTimeout(() => {
            button.textContent = originalText;
            button.title = originalTitle;
            button._copyFeedbackTimer = null;
        }, 900);
    }
    async copyToClipboard(text: string) {
        try {
            if (navigator.clipboard && navigator.clipboard.writeText) {
                await navigator.clipboard.writeText(text);
                return true;
            }
        }
        catch {
            // Fallback to legacy copy
        }
        return this.copyToClipboardLegacy(text);
    }
    copyToClipboardLegacy(text: string) {
        try {
            const textarea = document.createElement('textarea');
            textarea.value = text;
            textarea.setAttribute('readonly', '');
            textarea.style.position = 'fixed';
            textarea.style.top = '-9999px';
            textarea.style.left = '-9999px';
            document.body.appendChild(textarea);
            textarea.select();
            textarea.setSelectionRange(0, textarea.value.length);
            const success = document.execCommand('copy');
            document.body.removeChild(textarea);
            return success;
        }
        catch {
            return false;
        }
    }
}
(globalThis as unknown as { PanelUI: typeof PanelUI }).PanelUI = PanelUI;
