import type { Finding, ListenerRecord } from './types/listener';

export {};

// Findings tab rendering for Fransyfox panel
// Extracted from panel-ui.js for better organization
const findingsLog = FransyfoxLogger.scoped('panel-ui-findings');

interface PanelStorageLike {
  isListenerBlocked: (listener: ListenerRecord) => unknown;
  extractJsUrlFromStack: (stack?: string, fullstack?: string[]) => string | null;
}

interface FindingRule {
  id?: string;
  title?: string;
  description?: string;
  severity?: string;
  [key: string]: unknown;
}

interface FindingWithDetails extends Finding {
  details?: string;
  [key: string]: unknown;
}

interface FindingsEntry {
  listener: ListenerRecord;
  finding: FindingWithDetails;
  rule: FindingRule | null;
}

interface FindingsFilters {
  query?: string;
  severity?: string;
  listenerKey?: string | null;
}

type ListenerFocusHandler = (listener: ListenerRecord) => void;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function toFindingArray(value: unknown): FindingWithDetails[] {
  if (!Array.isArray(value)) return [];
  const findings: FindingWithDetails[] = [];

  for (const entry of value) {
    if (typeof entry === 'string') {
      findings.push({ id: entry });
      continue;
    }

    if (!isRecord(entry) || typeof entry.id !== 'string') {
      continue;
    }

    findings.push(entry as FindingWithDetails);
  }

  return findings;
}

function toRule(value: Record<string, unknown> | null): FindingRule | null {
  if (!value) return null;
  return value;
}

class PanelUIFindings {
  storage: PanelStorageLike;
  currentTabId: number | null;
  onFocusListener: ListenerFocusHandler | null;

  constructor(storage: PanelStorageLike) {
    this.storage = storage;
    this.currentTabId = null;
    this.onFocusListener = null;
  }

  setListenerFocusHandler(handler: ListenerFocusHandler): void {
    this.onFocusListener = handler;
  }

  extractLineColumnFromStack(stack: string | undefined, fullstack?: string[]): { line: string; column: string } | null {
    const lines = fullstack || (stack ? [stack] : []);
    for (const line of lines) {
      if (typeof line !== 'string') continue;
      if (!/https?:\/\//.test(line)) continue;
      const match = line.match(/:(\d+):(\d+)\)?$/);
      if (match) return { line: match[1], column: match[2] };
    }
    return null;
  }

  formatUrl(url: string | null | undefined): string {
    try {
      const urlObj = new URL(url ?? '');
      return urlObj.hostname + urlObj.pathname;
    } catch {
      return url || 'Unknown URL';
    }
  }

  getListenerFindings(listener: ListenerRecord | null | undefined): FindingWithDetails[] {
    if (!listener) return [];

    if (Array.isArray(listener.findings)) {
      return toFindingArray(listener.findings);
    }

    const hasRules = !!(globalThis.FransyfoxFindings && FransyfoxFindings.evaluateListener);
    const rulesVersion = globalThis.FransyfoxFindings ? FransyfoxFindings.version : null;

    if (listener.findingsVersion && rulesVersion && listener.findingsVersion === rulesVersion) {
      return [];
    }

    if (!hasRules) return [];

    const result =
      FransyfoxFindings.evaluateListener(listener) ||
      { findings: [], errors: [] };

    const findings = toFindingArray(result.findings);
    listener.findings = findings;
    if (rulesVersion) {
      listener.findingsVersion = rulesVersion;
    }
    return findings;
  }

  buildFindingsList(listeners: ListenerRecord[], excludeBlocked = false): FindingsEntry[] {
    const results: FindingsEntry[] = [];
    if (!Array.isArray(listeners)) return results;

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
        const findingId = typeof finding === 'string' ? finding : finding.id;
        if (!findingId) {
          continue;
        }

        const rawRule =
          globalThis.FransyfoxFindings && FransyfoxFindings.getRuleById
            ? FransyfoxFindings.getRuleById(findingId)
            : null;

        results.push({
          listener,
          finding: typeof finding === 'string' ? { id: finding } : finding,
          rule: toRule(rawRule)
        });
      }
    }

    return results;
  }

  formatListenerContext(listener: ListenerRecord): { domain: string; windowText: string } {
    const domain = listener.domain || 'unknown';
    let windowText =
      (listener.window ? listener.window + ' ' : '') +
      (listener.hops && listener.hops.length ? listener.hops : 'direct');
    windowText = windowText.replace(/%7B[^}]*%7D\s*/g, '').trim();
    if (!windowText || windowText === '') {
      windowText = 'direct';
    }
    return { domain, windowText };
  }

  getListenerKeyForFilter(listener: ListenerRecord | null | undefined): string {
    if (!listener) return '';

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

  applyFindingsFilters(findings: FindingsEntry[], filters: FindingsFilters | null): FindingsEntry[] {
    if (!Array.isArray(findings) || findings.length === 0) return [];

    const filter = filters || {};
    const query = (filter.query || '').trim().toLowerCase();
    const severity = filter.severity || 'any';
    const listenerKey = filter.listenerKey || null;

    return findings.filter((entry) => {
      const rule = entry.rule || {};
      const finding = entry.finding || {};
      const listener = entry.listener || ({ listener: '' });
      const entrySeverity = rule.severity || 'medium';

      if (severity !== 'any' && entrySeverity !== severity) {
        return false;
      }

      if (listenerKey) {
        const key = this.getListenerKeyForFilter(listener);
        if (key !== listenerKey) return false;
      }

      if (!query) return true;

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
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();

      return contextText.includes(query);
    });
  }

  displayFindings(
    listeners: ListenerRecord[],
    currentUrl: string,
    preserveScroll = false,
    filters: FindingsFilters | null = null
  ): void {
    try {
      requestAnimationFrame(() => {
        let savedScrollTop = 0;
        const contentElement = document.querySelector('.content');
        if (preserveScroll && contentElement) {
          savedScrollTop = contentElement.scrollTop;
        }

        const headerElement = document.getElementById('h');
        if (headerElement) {
          headerElement.textContent = this.formatUrl(currentUrl);
        }

        const countElement = document.getElementById('listener-count');
        const statusElement = document.getElementById('status-badge');
        if (countElement) {
          countElement.textContent = '';
        }

        const findings = this.applyFindingsFilters(this.buildFindingsList(listeners, true), filters);
        if (statusElement) {
          if (findings.length > 0) {
            statusElement.title = 'Findings detected';
            statusElement.className = 'status-dot warning';
          } else {
            statusElement.title = 'No findings';
            statusElement.className = 'status-dot inactive';
          }
        }

        const container = document.getElementById('x');
        if (!container) return;
        container.innerHTML = '';

        if (findings.length > 0) {
          const fragment = document.createDocumentFragment();
          for (let i = 0; i < findings.length; i++) {
            const entry = findings[i];
            const rule = entry.rule;
            const listener = entry.listener || ({ listener: '' });
            const finding = entry.finding || { id: '' };
            const severity = rule && rule.severity ? rule.severity : 'medium';

            const item = document.createElement('div');
            item.className = 'finding-item';
            item.classList.add('finding-clickable');
            item.addEventListener('click', (e: MouseEvent) => {
              const target = e.target;
              if (target instanceof Element && target.closest('a')) {
                return;
              }
              if (typeof this.onFocusListener === 'function') {
                this.onFocusListener(listener);
              }
            });

            const header = document.createElement('div');
            header.className = 'finding-header';

            const title = document.createElement('div');
            title.className = 'finding-title';
            title.textContent = rule ? rule.title || finding.id : finding.id;

            const severityBadge = document.createElement('div');
            severityBadge.className = `finding-severity severity-${severity}`;
            severityBadge.textContent = severity.toUpperCase();

            header.appendChild(title);
            header.appendChild(severityBadge);

            const meta = document.createElement('div');
            meta.className = 'finding-meta';

            const context = this.formatListenerContext(listener);
            const listenerLabel = document.createElement('div');
            listenerLabel.className = 'finding-listener';
            listenerLabel.textContent = `${context.domain} \u00b7 ${context.windowText}`;

            const ruleId = document.createElement('div');
            ruleId.className = 'finding-rule-id';
            ruleId.textContent = rule ? rule.id || finding.id : finding.id;

            meta.appendChild(listenerLabel);
            meta.appendChild(ruleId);

            const body = document.createElement('div');
            body.className = 'finding-body';

            const description = document.createElement('div');
            description.className = 'finding-description';
            description.textContent = rule ? rule.description || 'Finding triggered.' : 'Finding triggered.';
            body.appendChild(description);

            if (finding.details) {
              const details = document.createElement('div');
              details.className = 'finding-details';
              details.textContent = finding.details;
              body.appendChild(details);
            }

            const jsUrl = this.storage.extractJsUrlFromStack(listener.stack, listener.fullstack);
            if (jsUrl) {
              const lineColumn = this.extractLineColumnFromStack(listener.stack, listener.fullstack);
              const source = document.createElement('div');
              source.className = 'finding-source';
              const link = document.createElement('a');
              link.href = jsUrl;
              link.textContent = jsUrl;
              link.target = '_blank';
              link.rel = 'noreferrer';
              link.addEventListener('click', (e) => {
                e.preventDefault();
                const openInTab = () => chrome.tabs.create({ url: jsUrl });
                if (this.currentTabId) {
                  chrome.runtime.sendMessage({
                    action: 'openInDevtools',
                    url: jsUrl,
                    line: lineColumn ? parseInt(lineColumn.line, 10) : 1,
                    column: lineColumn ? parseInt(lineColumn.column, 10) : 0,
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
              source.appendChild(link);
              body.appendChild(source);
            }

            const snippetRaw = (listener.listener || '').replace(/\\s+/g, ' ').trim();
            if (snippetRaw) {
              const snippet = snippetRaw.length > 180 ? snippetRaw.slice(0, 180) + '...' : snippetRaw;
              const code = document.createElement('div');
              code.className = 'finding-code';
              code.textContent = snippet;
              body.appendChild(code);
            }

            item.appendChild(header);
            item.appendChild(meta);
            item.appendChild(body);
            fragment.appendChild(item);
          }
          container.appendChild(fragment);
        } else {
          const emptyState = document.createElement('div');
          emptyState.className = 'empty-state';
          emptyState.innerHTML = `
                        <div class="empty-title">No findings</div>
                        <div class="empty-description">
                            Known listener issues will show up here when detected.
                        </div>
                    `;
          container.appendChild(emptyState);
        }

        if (preserveScroll && contentElement && savedScrollTop > 0) {
          setTimeout(() => {
            contentElement.scrollTop = savedScrollTop;
          }, 0);
        }
      });
    } catch (error) {
      findingsLog.error('Error building findings list:', error);
    }
  }
}

(globalThis as unknown as { PanelUIFindings: typeof PanelUIFindings }).PanelUIFindings = PanelUIFindings;
