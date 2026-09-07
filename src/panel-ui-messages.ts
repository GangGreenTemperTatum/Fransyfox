import type { MessageEventRecord } from './types/listener';
import { VirtualHeightIndex } from './shared/virtual-height-index';

export {};

// Message tab rendering for Fransyfox panel
// Extracted from panel-ui.js for better organization
const messagesLog = FransyfoxLogger.scoped('panel-ui-messages');

type PanelMessageRecord = MessageEventRecord & {
  tabId?: number;
  ts?: number;
  sourceFrame?: string;
  targetFrame?: string;
  origin?: string;
  dataType?: string;
  dataText?: string;
  pageUrl?: string;
  /** Listener count in the receiving frame, annotated by the panel for correlation. */
  handledByCount?: number;
};

type CopyFeedbackButton = HTMLButtonElement & {
  _copyFeedbackTimer?: ReturnType<typeof setTimeout> | null;
};

interface PanelStorageLike {
  messageBeautifyEnabled?: boolean;
}

type MessageDisplayState = {
  emptyReason: 'none' | 'navigation' | 'manual' | 'eviction' | 'restored';
  restored: boolean;
  maxEvents: number;
  /** Events dropped by flood protection for the current tab. */
  droppedCount?: number;
};

class PanelUIMessages {
  storage: PanelStorageLike;
  expandedMessageKeys: Set<string>;
  collapsedMessageKeys: Set<string>;
  allMessagesExpanded: boolean;
  virtualMessages: PanelMessageRecord[];
  virtualState: MessageDisplayState;
  virtualListElement: HTMLElement | null;
  virtualContentElement: HTMLElement | null;
  virtualTopSpacer: HTMLElement | null;
  virtualItems: HTMLElement | null;
  virtualBottomSpacer: HTMLElement | null;
  virtualScrollElement: HTMLElement | null;
  virtualScrollHandler: (() => void) | null;
  virtualRenderFrame: number | null;
  renderedWindowKey: string;
  virtualRowHeights: Map<string, number>;
  virtualMessageIndexes: Map<string, number>;
  virtualHeightIndex: VirtualHeightIndex;
  formattedMessageCache: Map<string, string>;
  messageElementCache: Map<string, HTMLElement>;
  /** messageKey to flash-highlight (e.g. after "show in timeline" navigation). */
  pendingFlashKey: string | null = null;
  readonly collapsedRowHeight = 96;
  readonly expandedRowHeight = 240;
  readonly overscanPx = 2400;
  readonly maxCachedMessageElements = 250;

  constructor(storage: PanelStorageLike) {
    this.storage = storage;
    this.expandedMessageKeys = new Set<string>();
    this.collapsedMessageKeys = new Set<string>();
    this.allMessagesExpanded = false;
    this.virtualMessages = [];
    this.virtualState = { emptyReason: 'none', restored: false, maxEvents: 5000 };
    this.virtualListElement = null;
    this.virtualContentElement = null;
    this.virtualTopSpacer = null;
    this.virtualItems = null;
    this.virtualBottomSpacer = null;
    this.virtualScrollElement = null;
    this.virtualScrollHandler = null;
    this.virtualRenderFrame = null;
    this.renderedWindowKey = '';
    this.virtualRowHeights = new Map<string, number>();
    this.virtualMessageIndexes = new Map<string, number>();
    this.virtualHeightIndex = new VirtualHeightIndex();
    this.formattedMessageCache = new Map<string, string>();
    this.messageElementCache = new Map<string, HTMLElement>();

    // Close any open kebab dropdown when clicking outside
    document.addEventListener('click', () => {
      document.querySelectorAll('.message-dropdown.show, .listener-dropdown.show').forEach(d => {
        d.classList.remove('show');
      });
    });
  }

  getMessageKey(message: PanelMessageRecord): string {
    if (typeof message.id === 'number' && Number.isFinite(message.id)) {
      return `id:${message.id}`;
    }
    const parts = [
      String(message.ts || ''),
      String(message.tabId || ''),
      message.sourceFrame || '',
      message.targetFrame || '',
      message.origin || '',
      message.dataType || '',
      message.dataText || '',
      message.pageUrl || ''
    ];
    return parts.join('|');
  }

  isMessageExpanded(messageKey: string): boolean {
    if (this.allMessagesExpanded) {
      return !this.collapsedMessageKeys.has(messageKey);
    }
    return this.expandedMessageKeys.has(messageKey);
  }

  updateExpandButtonLabel(button: HTMLButtonElement, expanded: boolean): void {
    button.textContent = expanded ? 'Collapse' : 'Expand';
    button.title = expanded ? 'Collapse this message' : 'Expand this message';
  }

  toggleMessageExpanded(messageKey: string): boolean {
    if (this.allMessagesExpanded) {
      if (this.collapsedMessageKeys.has(messageKey)) {
        this.collapsedMessageKeys.delete(messageKey);
        return true;
      }
      this.collapsedMessageKeys.add(messageKey);
      return false;
    }
    if (this.expandedMessageKeys.has(messageKey)) {
      this.expandedMessageKeys.delete(messageKey);
      return false;
    }
    this.expandedMessageKeys.add(messageKey);
    return true;
  }

  toggleAllMessagesExpanded(): boolean {
    this.allMessagesExpanded = !this.allMessagesExpanded;
    this.expandedMessageKeys.clear();
    this.collapsedMessageKeys.clear();
    this.messageElementCache.clear();
    this.virtualRowHeights.clear();
    this.renderedWindowKey = '';
    return this.allMessagesExpanded;
  }

  setAllMessagesExpanded(expanded: boolean): void {
    this.allMessagesExpanded = !!expanded;
    this.expandedMessageKeys.clear();
    this.collapsedMessageKeys.clear();
    this.messageElementCache.clear();
    this.virtualRowHeights.clear();
    this.renderedWindowKey = '';
  }

  areAllMessagesExpanded(): boolean {
    return this.allMessagesExpanded;
  }

  pruneExpansionState(messageKeys: Set<string>): void {
    if (this.expandedMessageKeys.size > 0) {
      for (const key of this.expandedMessageKeys) {
        if (!messageKeys.has(key)) {
          this.expandedMessageKeys.delete(key);
        }
      }
    }
    if (this.collapsedMessageKeys.size > 0) {
      for (const key of this.collapsedMessageKeys) {
        if (!messageKeys.has(key)) {
          this.collapsedMessageKeys.delete(key);
        }
      }
    }
  }

  formatUrl(url: string | null | undefined): string {
    try {
      const urlObj = new URL(url ?? '');
      return urlObj.hostname + urlObj.pathname;
    } catch {
      return url || 'Unknown URL';
    }
  }

  displayMessages(
    messages: PanelMessageRecord[],
    currentUrl: string,
    _onRefresh: (() => void | Promise<void>) | null,
    preserveScroll = false,
    state?: MessageDisplayState
  ): void {
    try {
      requestAnimationFrame(() => {
        let savedScrollTop = 0;
        const contentElement = document.querySelector<HTMLElement>('.content');
        if (preserveScroll && contentElement) {
          savedScrollTop = contentElement.scrollTop;
        }
        this.virtualMessages = Array.isArray(messages) ? messages : [];
        this.virtualState = state || { emptyReason: 'none', restored: false, maxEvents: 5000 };
        const renderedMessageKeys = this.syncVirtualMessageMetrics();

        const headerElement = document.getElementById('h');
        if (headerElement) {
          headerElement.textContent = this.formatUrl(currentUrl);
        }

        const countElement = document.getElementById('listener-count');
        const statusElement = document.getElementById('status-badge');
        if (countElement) {
          countElement.textContent = '';
        }
        if (statusElement) {
          statusElement.title = 'Messages';
          statusElement.className = 'status-dot';
        }

        const container = document.getElementById('x');
        if (!container) return;

        if (this.virtualMessages.length > 0) {
          this.pruneExpansionState(renderedMessageKeys);
          this.pruneVirtualCaches(renderedMessageKeys);
          this.ensureVirtualScaffold(container, contentElement);
          this.renderVirtualMessages();
        } else {
          this.detachVirtualScroll();
          this.virtualListElement = null;
          this.renderedWindowKey = '';
          this.pruneExpansionState(new Set<string>());
          this.pruneVirtualCaches(new Set<string>());
          container.innerHTML = '';
          const emptyState = document.createElement('div');
          emptyState.className = 'empty-state';
          const title = document.createElement('div');
          title.className = 'empty-title';
          title.textContent = this.getEmptyTitle();
          const description = document.createElement('div');
          description.className = 'empty-description';
          description.textContent = this.getEmptyDescription();
          emptyState.appendChild(title);
          emptyState.appendChild(description);
          container.appendChild(emptyState);
        }

        // Rendered after the branches above since both may reset the container
        this.updateDroppedNotice(container);

        if (preserveScroll && contentElement && savedScrollTop > 0) {
          setTimeout(() => {
            contentElement.scrollTop = savedScrollTop;
          }, 0);
        }
      });
    } catch (error) {
      messagesLog.error('Error building message list:', error);
    }
  }

  // Scroll the Messages list to a specific message id and flash it. Returns
  // false if the message isn't in the current (filtered) list yet so the caller
  // can retry after data loads.
  focusMessage(messageId: number): boolean {
    if (!Array.isArray(this.virtualMessages) || this.virtualMessages.length === 0) {
      return false;
    }
    const index = this.virtualMessages.findIndex(
      (message) => typeof message.id === 'number' && message.id === messageId
    );
    if (index < 0) {
      return false;
    }
    const key = `id:${messageId}`;
    this.pendingFlashKey = key;
    // Bring the row into the virtual window by scrolling near its offset.
    if (this.virtualHeightIndex.length !== this.virtualMessages.length) {
      this.syncVirtualMessageMetrics();
    }
    const offset = this.virtualHeightIndex.prefixHeight(index);
    const scroller = this.virtualScrollElement;
    if (scroller) {
      scroller.scrollTop = Math.max(0, offset - 16);
    }
    this.renderedWindowKey = '';
    this.renderVirtualMessages();
    requestAnimationFrame(() => {
      const el = this.virtualItems
        ? this.virtualItems.querySelector<HTMLElement>(`.message-item[data-message-key="${CSS.escape(key)}"]`)
        : null;
      if (el) {
        el.scrollIntoView({ block: 'center' });
      }
    });
    // Clear the flash after the highlight animation so future renders don't keep it.
    setTimeout(() => {
      if (this.pendingFlashKey === key) {
        this.pendingFlashKey = null;
        if (this.virtualItems) {
          this.virtualItems
            .querySelectorAll<HTMLElement>('.message-item.message-flash')
            .forEach((el) => el.classList.remove('message-flash'));
        }
      }
    }, 2200);
    return true;
  }

  // Show/refresh a banner when flood protection has dropped events for this tab
  updateDroppedNotice(container: HTMLElement): void {
    const dropped = this.virtualState.droppedCount || 0;
    let notice = container.querySelector<HTMLElement>('.messages-dropped-notice');
    if (dropped <= 0) {
      if (notice) notice.remove();
      return;
    }
    if (!notice) {
      notice = document.createElement('div');
      notice.className = 'messages-dropped-notice';
      notice.style.cssText =
        'background:#fef3c7;color:#92400e;border:1px solid #f59e0b;border-radius:4px;' +
        'padding:6px 10px;margin:6px 0;font-size:12px;font-weight:600;';
      container.insertBefore(notice, container.firstChild);
    }
    notice.textContent =
      `Flood protection dropped ${dropped} message${dropped === 1 ? '' : 's'} on this tab ` +
      '(disable in settings to capture everything).';
  }

  ensureVirtualScaffold(container: HTMLElement, contentElement: HTMLElement | null): void {
    if (
      this.virtualListElement &&
      this.virtualTopSpacer &&
      this.virtualItems &&
      this.virtualBottomSpacer &&
      container.contains(this.virtualListElement)
    ) {
      this.attachVirtualScroll(contentElement);
      return;
    }

    container.innerHTML = '';
    this.renderedWindowKey = '';
    this.virtualListElement = document.createElement('div');
    this.virtualListElement.className = 'messages-virtual-list';
    this.virtualTopSpacer = document.createElement('div');
    this.virtualTopSpacer.className = 'messages-virtual-spacer';
    this.virtualItems = document.createElement('div');
    this.virtualItems.className = 'messages-virtual-items';
    this.virtualBottomSpacer = document.createElement('div');
    this.virtualBottomSpacer.className = 'messages-virtual-spacer';

    this.virtualListElement.appendChild(this.virtualTopSpacer);
    this.virtualListElement.appendChild(this.virtualItems);
    this.virtualListElement.appendChild(this.virtualBottomSpacer);
    container.appendChild(this.virtualListElement);
    this.attachVirtualScroll(contentElement);
  }

  attachVirtualScroll(contentElement: HTMLElement | null): void {
    if (this.virtualScrollElement === contentElement && this.virtualScrollHandler) {
      return;
    }
    this.detachVirtualScroll();
    this.virtualScrollElement = contentElement;
    if (!contentElement) return;
    this.virtualScrollHandler = () => this.scheduleVirtualRender();
    contentElement.addEventListener('scroll', this.virtualScrollHandler, { passive: true });
  }

  detachVirtualScroll(): void {
    if (this.virtualScrollElement && this.virtualScrollHandler) {
      this.virtualScrollElement.removeEventListener('scroll', this.virtualScrollHandler);
    }
    this.virtualScrollElement = null;
    this.virtualScrollHandler = null;
    if (this.virtualRenderFrame !== null) {
      cancelAnimationFrame(this.virtualRenderFrame);
      this.virtualRenderFrame = null;
    }
  }

  scheduleVirtualRender(): void {
    if (this.virtualRenderFrame !== null) {
      return;
    }
    this.virtualRenderFrame = requestAnimationFrame(() => {
      this.virtualRenderFrame = null;
      this.renderVirtualMessages();
    });
  }

  getEstimatedMessageHeight(message: PanelMessageRecord): number {
    const key = this.getMessageKey(message);
    const measured = this.virtualRowHeights.get(key);
    if (measured && measured > 0) {
      return measured;
    }
    return this.isMessageExpanded(key) ? this.expandedRowHeight : this.collapsedRowHeight;
  }

  syncVirtualMessageMetrics(): Set<string> {
    const messageKeys = new Set<string>();
    const heights = new Array<number>(this.virtualMessages.length);
    this.virtualMessageIndexes.clear();
    for (let index = 0; index < this.virtualMessages.length; index += 1) {
      const message = this.virtualMessages[index];
      const key = this.getMessageKey(message);
      messageKeys.add(key);
      this.virtualMessageIndexes.set(key, index);
      heights[index] = this.getEstimatedMessageHeight(message);
    }
    this.virtualHeightIndex.reset(heights);
    return messageKeys;
  }

  getVisibleRange(): { start: number; end: number; topHeight: number; bottomHeight: number } {
    if (this.virtualMessages.length === 0) {
      return { start: 0, end: 0, topHeight: 0, bottomHeight: 0 };
    }
    const contentElement = this.virtualScrollElement;
    const scrollTop = contentElement ? contentElement.scrollTop : 0;
    const viewportHeight = contentElement ? contentElement.clientHeight : 600;
    const minY = Math.max(0, scrollTop - this.overscanPx);
    const maxY = scrollTop + viewportHeight + this.overscanPx;
    if (this.virtualHeightIndex.length !== this.virtualMessages.length) {
      this.syncVirtualMessageMetrics();
    }
    const start = this.virtualHeightIndex.findRowAt(minY);
    const end = Math.max(start + 1, this.virtualHeightIndex.findEndAfter(maxY));
    const topHeight = this.virtualHeightIndex.prefixHeight(start);
    const renderedBottom = this.virtualHeightIndex.prefixHeight(end);
    const bottomHeight = Math.max(0, this.virtualHeightIndex.totalHeight - renderedBottom);
    return { start, end, topHeight, bottomHeight };
  }

  renderVirtualMessages(): void {
    if (!this.virtualTopSpacer || !this.virtualItems || !this.virtualBottomSpacer) {
      return;
    }
    const range = this.getVisibleRange();
    this.virtualTopSpacer.style.height = `${range.topHeight}px`;
    this.virtualBottomSpacer.style.height = `${range.bottomHeight}px`;
    const windowKey = this.getWindowRenderKey(range.start, range.end);
    if (windowKey === this.renderedWindowKey) {
      return;
    }

    const fragment = document.createDocumentFragment();
    for (let i = range.start; i < range.end; i += 1) {
      const message = this.virtualMessages[i];
      if (!message) continue;
      fragment.appendChild(this.buildMessageItem(message));
    }
    this.virtualItems.replaceChildren(fragment);
    this.renderedWindowKey = windowKey;
    requestAnimationFrame(() => this.measureVisibleRows());
  }

  getWindowRenderKey(start: number, end: number): string {
    const first = this.virtualMessages[start];
    const last = this.virtualMessages[Math.max(start, end - 1)];
    const firstKey = first ? this.getMessageKey(first) : '';
    const lastKey = last ? this.getMessageKey(last) : '';
    const mode = this.storage && this.storage.messageBeautifyEnabled ? 'pretty' : 'raw';
    return [
      start,
      end,
      this.virtualMessages.length,
      firstKey,
      lastKey,
      mode,
      this.allMessagesExpanded ? 'all' : 'some',
      this.expandedMessageKeys.size,
      this.collapsedMessageKeys.size
    ].join('|');
  }

  measureVisibleRows(): void {
    if (!this.virtualItems) return;
    let heightChanged = false;
    this.virtualItems.querySelectorAll<HTMLElement>('.message-item[data-message-key]').forEach((item) => {
      const key = item.dataset.messageKey;
      if (!key) return;
      const height = item.offsetHeight + 6;
      if (height > 0) {
        this.virtualRowHeights.set(key, height);
        const index = this.virtualMessageIndexes.get(key);
        if (index !== undefined) {
          heightChanged = this.virtualHeightIndex.update(index, height) || heightChanged;
        }
      }
    });
    if (heightChanged) {
      this.scheduleVirtualRender();
    }
  }

  getMessageRenderKey(message: PanelMessageRecord): string {
    const messageKey = this.getMessageKey(message);
    const expanded = this.isMessageExpanded(messageKey) ? 'expanded' : 'collapsed';
    const mode = this.storage && this.storage.messageBeautifyEnabled ? 'pretty' : 'raw';
    // Receiving-frame listener count is annotated by the panel before render;
    // include it so the row re-renders when listener data for the frame changes.
    const handled = typeof message.handledByCount === 'number' ? message.handledByCount : -1;
    return `${messageKey}::${expanded}::${mode}::h${handled}`;
  }

  buildMessageItem(message: PanelMessageRecord): HTMLElement {
    const messageKey = this.getMessageKey(message);
    const renderKey = this.getMessageRenderKey(message);
    const flash = this.pendingFlashKey !== null && messageKey === this.pendingFlashKey;
    const cached = this.messageElementCache.get(renderKey);
    if (cached && !cached.isConnected) {
      cached.querySelectorAll('.message-dropdown.show').forEach((dropdown) => {
        dropdown.classList.remove('show');
      });
      cached.classList.toggle('message-flash', flash);
      return cached;
    }

    const item = document.createElement('div');
    item.className = 'message-item';
    item.dataset.messageKey = messageKey;
    item.dataset.renderKey = renderKey;
    const expanded = this.isMessageExpanded(messageKey);
    item.classList.toggle('is-collapsed', !expanded);
    item.classList.toggle('message-flash', flash);

    const header = document.createElement('div');
    header.className = 'message-header';

    const meta = document.createElement('div');
    meta.className = 'message-meta';

    const source = document.createElement('div');
    source.className = 'message-target';
    source.title = message.sourceFrame || 'unknown';
    source.textContent = message.sourceFrame || 'unknown';

    const target = document.createElement('div');
    target.className = 'message-target';
    target.title = message.targetFrame || 'unknown';
    target.textContent = message.targetFrame || 'unknown';

    const origin = document.createElement('div');
    origin.className = 'message-origin';
    origin.title = message.origin || 'unknown';
    origin.textContent = message.origin || 'unknown';

    meta.appendChild(source);
    meta.appendChild(target);
    meta.appendChild(origin);

    // Correlation: how many listeners are registered in the receiving frame.
    if (typeof message.handledByCount === 'number' && message.handledByCount > 0) {
      const handled = document.createElement('div');
      handled.className = 'message-handled-badge';
      handled.textContent = `▸ ${message.handledByCount} listener${message.handledByCount === 1 ? '' : 's'}`;
      handled.title = 'Listeners registered in the receiving frame (the handlers this message reaches).';
      meta.appendChild(handled);
    }

    if (message.dataTruncated) {
      const truncatedBadge = document.createElement('div');
      truncatedBadge.className = 'message-truncated-badge';
      truncatedBadge.style.cssText =
        'color:#92400e;background:#fef3c7;border-radius:3px;padding:0 5px;font-size:10px;font-weight:700;';
      const originalLength = typeof message.dataLength === 'number' ? message.dataLength : null;
      truncatedBadge.textContent = originalLength !== null
        ? `truncated at capture · ${originalLength} chars`
        : 'truncated at capture';
      truncatedBadge.title = 'Captured under the max message size setting; the original payload was larger.';
      meta.appendChild(truncatedBadge);
    }

    const actions = document.createElement('div');
    actions.className = 'message-actions';

    const kebabBtn = document.createElement('button');
    kebabBtn.className = 'message-kebab-btn';
    kebabBtn.type = 'button';
    kebabBtn.textContent = '\u22EE';
    kebabBtn.title = 'Actions';

    const dropdown = document.createElement('div');
    dropdown.className = 'message-dropdown';

    const copyItem = document.createElement('button');
    copyItem.className = 'message-dropdown-item';
    copyItem.type = 'button';
    copyItem.textContent = 'Copy raw message';
    copyItem.addEventListener('click', (event: MouseEvent) => {
      event.stopPropagation();
      dropdown.classList.remove('show');
      const rawText = typeof message.dataText === 'string' ? message.dataText : '';
      void this.copyTextWithFeedback(rawText, kebabBtn);
    });

    const copyPostItem = document.createElement('button');
    copyPostItem.className = 'message-dropdown-item';
    copyPostItem.type = 'button';
    copyPostItem.textContent = 'Copy as postMessage';
    copyPostItem.addEventListener('click', (event: MouseEvent) => {
      event.stopPropagation();
      dropdown.classList.remove('show');
      const snippet = this.buildPostMessageSnippet(message);
      void this.copyTextWithFeedback(snippet, kebabBtn);
    });

    const repeaterItem = document.createElement('button');
    repeaterItem.className = 'message-dropdown-item';
    repeaterItem.type = 'button';
    repeaterItem.textContent = 'Send to Repeater';
    repeaterItem.addEventListener('click', (event: MouseEvent) => {
      event.stopPropagation();
      dropdown.classList.remove('show');
      // Loosely coupled to the panel: it loads this message into the Composer.
      document.dispatchEvent(new CustomEvent('fransyfox:repeater-load', {
        detail: {
          dataText: typeof message.dataText === 'string' ? message.dataText : '',
          dataType: typeof message.dataType === 'string' ? message.dataType : '',
          frameId: typeof message.frameId === 'number' ? message.frameId : null,
          origin: typeof message.origin === 'string' ? message.origin : '',
          targetFrame: typeof message.targetFrame === 'string' ? message.targetFrame : ''
        }
      }));
    });

    const timelineItem = document.createElement('button');
    timelineItem.className = 'message-dropdown-item';
    timelineItem.type = 'button';
    timelineItem.textContent = 'Show in timeline';
    timelineItem.addEventListener('click', (event: MouseEvent) => {
      event.stopPropagation();
      dropdown.classList.remove('show');
      if (typeof message.id === 'number') {
        document.dispatchEvent(new CustomEvent('fransyfox:show-in-timeline', {
          detail: { id: message.id }
        }));
      }
    });

    const expandItem = document.createElement('button');
    expandItem.className = 'message-dropdown-item';
    expandItem.type = 'button';
    expandItem.textContent = expanded ? 'Collapse' : 'Expand';
    expandItem.addEventListener('click', (event: MouseEvent) => {
      event.stopPropagation();
      dropdown.classList.remove('show');
      this.toggleMessageExpanded(messageKey);
      this.virtualRowHeights.delete(messageKey);
      const messageIndex = this.virtualMessageIndexes.get(messageKey);
      const message = messageIndex !== undefined ? this.virtualMessages[messageIndex] : null;
      if (messageIndex !== undefined && message) {
        this.virtualHeightIndex.update(messageIndex, this.getEstimatedMessageHeight(message));
      }
      this.deleteCachedMessageElements(messageKey);
      this.renderedWindowKey = '';
      this.renderVirtualMessages();
    });

    kebabBtn.addEventListener('click', (event: MouseEvent) => {
      event.stopPropagation();
      document.querySelectorAll('.message-dropdown.show').forEach(d => {
        if (d !== dropdown) d.classList.remove('show');
      });
      dropdown.classList.toggle('show');
    });

    dropdown.appendChild(copyItem);
    dropdown.appendChild(copyPostItem);
    dropdown.appendChild(repeaterItem);
    dropdown.appendChild(timelineItem);
    dropdown.appendChild(expandItem);
    actions.appendChild(kebabBtn);
    actions.appendChild(dropdown);

    const timestamp = document.createElement('div');
    timestamp.className = 'message-timestamp';
    const date = new Date(message.ts || Date.now());
    timestamp.textContent = date.toLocaleTimeString();

    header.appendChild(meta);
    header.appendChild(actions);
    header.appendChild(timestamp);

    const body = document.createElement('div');
    body.className = 'message-body';
    body.textContent = this.formatMessageData(message);

    item.appendChild(header);
    item.appendChild(body);
    this.messageElementCache.set(renderKey, item);
    this.trimMessageElementCache();
    return item;
  }

  trimMessageElementCache(): void {
    if (this.messageElementCache.size <= this.maxCachedMessageElements) {
      return;
    }
    for (const [key, element] of this.messageElementCache) {
      if (this.messageElementCache.size <= this.maxCachedMessageElements) {
        return;
      }
      if (!element.isConnected) {
        this.messageElementCache.delete(key);
      }
    }
  }

  deleteCachedMessageElements(messageKey: string): void {
    for (const key of this.messageElementCache.keys()) {
      if (key.startsWith(`${messageKey}::`)) {
        this.messageElementCache.delete(key);
      }
    }
  }

  pruneVirtualCaches(messageKeys: Set<string>): void {
    for (const key of this.virtualRowHeights.keys()) {
      if (!messageKeys.has(key)) {
        this.virtualRowHeights.delete(key);
      }
    }
    for (const key of this.formattedMessageCache.keys()) {
      const messageKey = key.split('::')[0];
      if (!messageKeys.has(messageKey)) {
        this.formattedMessageCache.delete(key);
      }
    }
    for (const key of this.messageElementCache.keys()) {
      const messageKey = key.split('::')[0];
      if (!messageKeys.has(messageKey)) {
        this.messageElementCache.delete(key);
      }
    }
  }

  getEmptyTitle(): string {
    if (this.virtualState.emptyReason === 'navigation') return 'Messages cleared on navigation';
    if (this.virtualState.emptyReason === 'manual') return 'Messages cleared';
    if (this.virtualState.emptyReason === 'eviction') return 'Older messages evicted';
    if (this.virtualState.emptyReason === 'restored') return 'No restored messages';
    return 'No messages captured';
  }

  getEmptyDescription(): string {
    if (this.virtualState.emptyReason === 'navigation') {
      return 'Preserve Log keeps message traffic across navigations.';
    }
    if (this.virtualState.emptyReason === 'manual') {
      return 'The current tab message log was cleared manually.';
    }
    if (this.virtualState.emptyReason === 'eviction') {
      return `The message log keeps the newest ${this.virtualState.maxEvents || 5000} events.`;
    }
    if (this.virtualState.emptyReason === 'restored') {
      return 'No persisted messages were available for this tab.';
    }
    return 'PostMessage traffic will appear here when detected.';
  }

  formatMessageData(message: PanelMessageRecord): string {
    const messageKey = this.getMessageKey(message);
    const cacheKey = `${messageKey}::${this.storage && this.storage.messageBeautifyEnabled ? 'pretty' : 'raw'}`;
    const cached = this.formattedMessageCache.get(cacheKey);
    if (cached !== undefined) {
      return cached;
    }
    const text = message && message.dataText ? message.dataText : '';
    if (!this.storage || !this.storage.messageBeautifyEnabled) {
      this.formattedMessageCache.set(cacheKey, text);
      return text;
    }
    if (!text) {
      this.formattedMessageCache.set(cacheKey, text);
      return text;
    }
    try {
      const parsed: unknown = JSON.parse(text);
      const formatted = JSON.stringify(parsed, null, 2);
      this.formattedMessageCache.set(cacheKey, formatted);
      return formatted;
    } catch {
      this.formattedMessageCache.set(cacheKey, text);
      return text;
    }
  }

  getPostMessageTarget(targetFrame: string | null | undefined): string {
    if (!targetFrame || targetFrame === 'unknown' || targetFrame === 'diffwin') {
      return 'top';
    }
    return targetFrame;
  }

  formatPostMessagePayload(message: PanelMessageRecord | null | undefined): string {
    if (!message) return 'undefined';
    const dataType = message.dataType || '';
    const dataText = typeof message.dataText === 'string' ? message.dataText : '';

    if (dataType === 'string') {
      return JSON.stringify(dataText);
    }
    if (dataType === 'undefined' || dataType === 'function' || dataType === 'symbol') {
      return 'undefined';
    }
    if (!dataText) {
      return 'undefined';
    }

    try {
      JSON.parse(dataText);
      return dataText;
    } catch {
      return JSON.stringify(dataText);
    }
  }

  buildPostMessageSnippet(message: PanelMessageRecord | null | undefined): string {
    const target = this.getPostMessageTarget(message ? message.targetFrame : '');
    const payload = this.formatPostMessagePayload(message);
    return `${target}.postMessage(${payload}, "*")`;
  }

  async copyTextWithFeedback(text: string, button: CopyFeedbackButton): Promise<void> {
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

  async copyToClipboard(text: string): Promise<boolean> {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch {
      // Fallback to legacy copy
    }
    return this.copyToClipboardLegacy(text);
  }

  copyToClipboardLegacy(text: string): boolean {
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
    } catch {
      return false;
    }
  }
}

(globalThis as unknown as { PanelUIMessages: typeof PanelUIMessages }).PanelUIMessages = PanelUIMessages;
