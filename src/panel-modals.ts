import { MAX_USER_REGEX_RULES, compileSafeRegex } from './shared/safe-regex';

export {};
// Modal management for Fransceiver panel
// Handles: Regex editor, Highlight editor, Settings modal, Export/Import
const modalLog = FransceiverLogger.scoped('panel-modals');

type HighlightRules = Record<string, string[]>;
type RefreshHandler = (isManual: boolean) => void | Promise<void>;
type ReHighlightHandler = (forceRebuild: boolean) => void;
type ImportResultCallback = (err: Error | null, message?: string) => void;

interface PanelStorageLike {
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
  messageMaxCaptureSize: number;
  floodProtectionEnabled: boolean;
  parseRegexText: (text: string) => string[];
  saveRegexPatterns: (patterns: string[]) => void;
  saveHighlightRules: (rules: HighlightRules, rulesText: string) => void;
  saveLogUrl: (logUrl: string) => Promise<void>;
  savePrettifySetting: (enabled: boolean) => Promise<void>;
  saveSyntaxHighlightSetting: (enabled: boolean) => Promise<void>;
  saveDedupeSetting: (enabled: boolean) => Promise<void>;
  saveCodeSettings: () => void;
  saveMessageDebugSettings: (settings: {
    consoleLogEnabled: boolean;
    debugBreakEnabled: boolean;
    debugBreakMatch: string;
    maxCapturedMessageSize: number;
  }) => Promise<void>;
  saveFloodProtectionSetting: (enabled: boolean) => Promise<void>;
  exportBlockedUrls: () => void;
  importBlockedUrls: (file: File, callback: ImportResultCallback) => void;
  clearBlockedUrls: () => void;
  exportBlockedListeners: () => void;
  importBlockedListeners: (file: File, callback: ImportResultCallback) => void;
  clearBlockedListeners: () => void;
}

interface PanelDomCacheLike {
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
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === 'string');
}

class PanelModals {
  storage: PanelStorageLike;
  domCache: PanelDomCacheLike;
  onRefreshRequest: RefreshHandler | null;
  onReHighlight: ReHighlightHandler | null;
  onClearPrettifyCache: (() => void) | null;

  constructor(storage: PanelStorageLike, domCache: PanelDomCacheLike) {
    this.storage = storage;
    this.domCache = domCache;
    this.onRefreshRequest = null;
    this.onReHighlight = null;
    this.onClearPrettifyCache = null;
  }

  // Set callback for when modals need to trigger a data refresh
  setRefreshHandler(handler: RefreshHandler): void {
    this.onRefreshRequest = handler;
  }

  // Set callback for re-highlighting code blocks
  setReHighlightHandler(handler: ReHighlightHandler): void {
    this.onReHighlight = handler;
  }

  // Set callback for clearing prettify cache
  setClearPrettifyCacheHandler(handler: () => void): void {
    this.onClearPrettifyCache = handler;
  }

  // Initialize all modals
  init(): void {
    this.setupRegexEditor();
    this.setupHighlightEditor();
    this.setupSettingsModal();
  }

  // Setup regex editor modal
  setupRegexEditor(): void {
    modalLog.info('Setting up regex editor...');
    const regexBtn = this.domCache.regexBtn;
    const modal = this.domCache.regexModal;
    const textarea = this.domCache.regexTextarea;
    const saveBtn = this.domCache.regexSave;
    const cancelBtn = this.domCache.regexCancel;

    if (!regexBtn || !modal || !textarea || !saveBtn || !cancelBtn) {
      modalLog.error('Some regex modal elements not found in cache:', {
        regexBtn: !!regexBtn,
        modal: !!modal,
        textarea: !!textarea,
        saveBtn: !!saveBtn,
        cancelBtn: !!cancelBtn
      });
      return;
    }

    // Load existing regex patterns into textarea
    chrome.storage.local.get(['blockedRegex'], (result: Record<string, unknown>) => {
      const blockedRegex = toStringArray(result.blockedRegex);
      if (blockedRegex.length > 0) {
        textarea.value = blockedRegex.join('\n');
        modalLog.info('Loaded existing regex patterns:', blockedRegex);
      }
    });

    // Remove any existing event listeners to avoid duplicates
    const newRegexBtnNode = regexBtn.cloneNode(true);
    if (!(newRegexBtnNode instanceof HTMLButtonElement) || !regexBtn.parentNode) {
      return;
    }
    regexBtn.parentNode.replaceChild(newRegexBtnNode, regexBtn);

    // Update cache reference to the new button
    this.domCache.regexBtn = newRegexBtnNode;

    // Open modal - using the cloned button
    newRegexBtnNode.addEventListener('click', (e: MouseEvent) => {
      modalLog.info('Regex button clicked!');
      e.preventDefault();
      e.stopPropagation();

      // Reload patterns in case they changed
      chrome.storage.local.get(['blockedRegex'], (result: Record<string, unknown>) => {
        const blockedRegex = toStringArray(result.blockedRegex);
        textarea.value = blockedRegex.length > 0 ? blockedRegex.join('\n') : '';
      });

      // Show the modal
      modal.style.display = 'flex';
      modal.classList.add('show');
      modal.style.zIndex = '9999';
      modal.style.position = 'fixed';
      modal.style.top = '0';
      modal.style.left = '0';
      modal.style.right = '0';
      modal.style.bottom = '0';
      modal.style.backgroundColor = 'rgba(0, 0, 0, 0.5)';
      modal.style.alignItems = 'center';
      modal.style.justifyContent = 'center';
    });

    // Close modal
    cancelBtn.addEventListener('click', (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      modal.style.display = 'none';
      modal.classList.remove('show');
    });

    // Close modal when clicking outside
    modal.addEventListener('click', (e: MouseEvent) => {
      if (e.target === modal) {
        modal.style.display = 'none';
        modal.classList.remove('show');
      }
    });

    // Save and apply regex patterns
    saveBtn.addEventListener('click', (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      void (async () => {
        const regexText = textarea.value;
        const patterns = this.storage.parseRegexText(regexText);
        if (patterns.length > MAX_USER_REGEX_RULES) {
          textarea.setCustomValidity(`At most ${MAX_USER_REGEX_RULES} regex patterns are allowed.`);
          textarea.reportValidity();
          return;
        }
        const rejectedPattern = patterns
          .map((pattern) => ({ pattern, result: compileSafeRegex(pattern, 'i') }))
          .find((entry) => !entry.result.regex);
        if (rejectedPattern) {
          textarea.setCustomValidity(
            `Rejected pattern "${rejectedPattern.pattern}": ${rejectedPattern.result.error || 'Invalid regular expression.'}`
          );
          textarea.reportValidity();
          return;
        }
        textarea.setCustomValidity('');
        modalLog.info('Saved regex patterns:', patterns);

        // Save patterns to storage
        this.storage.saveRegexPatterns(patterns);

        // Request data refresh
        if (this.onRefreshRequest) {
          await this.onRefreshRequest(true);
        }

        modal.style.display = 'none';
        modal.classList.remove('show');
      })();
    });

    modalLog.info('Regex editor setup complete');
  }

  // Setup highlight editor modal
  setupHighlightEditor(): void {
    const highlightBtn = this.domCache.highlightBtn;
    const modal = this.domCache.highlightModal;
    const textarea = this.domCache.highlightTextarea;
    const saveBtn = this.domCache.highlightSave;
    const cancelBtn = this.domCache.highlightCancel;

    if (!highlightBtn || !modal || !textarea || !saveBtn || !cancelBtn) {
      modalLog.error('Highlight editor elements not found in cache');
      return;
    }

    // Load existing rules into textarea
    chrome.storage.local.get(['highlightRulesText'], (result: Record<string, unknown>) => {
      if (typeof result.highlightRulesText === 'string') {
        textarea.value = result.highlightRulesText;
      }
    });

    // Open modal
    highlightBtn.addEventListener('click', () => {
      // Reload rules text in case it changed
      chrome.storage.local.get(['highlightRulesText'], (result: Record<string, unknown>) => {
        textarea.value = typeof result.highlightRulesText === 'string' ? result.highlightRulesText : '';
      });
      modal.classList.add('show');
    });

    // Close modal
    cancelBtn.addEventListener('click', () => {
      modal.classList.remove('show');
    });

    // Close modal when clicking outside
    modal.addEventListener('click', (e: MouseEvent) => {
      if (e.target === modal) {
        modal.classList.remove('show');
      }
    });

    // Save and apply rules
    saveBtn.addEventListener('click', () => {
      const rulesText = textarea.value;
      const parsedRules = this.parseHighlightText(rulesText);
      modalLog.info('Saving highlight rules:', parsedRules);

      // Save rules to storage
      this.storage.saveHighlightRules(parsedRules, rulesText);

      // Re-highlight all code blocks (preserve syntax highlighting since only custom rules changed)
      if (this.onReHighlight) {
        this.onReHighlight(false);
      }

      modal.classList.remove('show');
    });
  }

  // Parse highlight text into rules object (duplicated from UI for decoupling)
  parseHighlightText(text: string): HighlightRules {
    const rules: HighlightRules = {};
    const lines = text.split('\n');
    let currentColor: string | null = null;

    for (const line of lines) {
      const trimmedLine = line.trim();
      if (!trimmedLine) {
        continue;
      }

      const colorMatch = trimmedLine.match(/^\[(\w+)\]$/);
      if (colorMatch) {
        currentColor = colorMatch[1].toLowerCase();
        if (!rules[currentColor]) {
          rules[currentColor] = [];
        }
        continue;
      }

      if (currentColor && trimmedLine) {
        const terms = trimmedLine
          .split(',')
          .map((term) => term.trim())
          .filter((term) => term.length > 0);
        rules[currentColor].push(...terms);
      }
    }

    return rules;
  }

  // Setup settings modal
  setupSettingsModal(): void {
    const settingsBtn = document.getElementById('settings-btn');
    const modal = document.getElementById('settings-modal');
    const urlInput = document.getElementById('logging-url-input') as HTMLInputElement | null;
    const saveBtn = document.getElementById('settings-save');
    const cancelBtn = document.getElementById('settings-cancel');
    const prettifyToggle = document.getElementById('prettify-toggle') as HTMLInputElement | null;
    const dedupeToggle = document.getElementById('dedupe-toggle') as HTMLInputElement | null;
    const syntaxHighlightToggle = document.getElementById('syntax-highlight-toggle') as HTMLInputElement | null;
    const messageConsoleLogToggle = document.getElementById('message-console-log-toggle') as HTMLInputElement | null;
    const messageDebugBreakToggle = document.getElementById('message-debug-break-toggle') as HTMLInputElement | null;
    const messageDebugMatchInput = document.getElementById('message-debug-match-input') as HTMLInputElement | null;
    const floodProtectionToggle = document.getElementById('flood-protection-toggle') as HTMLInputElement | null;
    const maxCaptureSizeInput = document.getElementById('max-capture-size-input') as HTMLInputElement | null;

    // Code display settings
    const expandThresholdInput = document.getElementById('expand-threshold-input') as HTMLInputElement | null;
    const maxLinesInput = document.getElementById('max-lines-input') as HTMLInputElement | null;
    const fontSizeInput = document.getElementById('font-size-input') as HTMLInputElement | null;

    if (!settingsBtn || !modal) {
      modalLog.error('Settings elements not found');
      return;
    }

    // Open settings modal
    settingsBtn.addEventListener('click', () => {
      // Reset input to original value when opening modal
      if (urlInput) {
        urlInput.value = this.storage.originalLogUrl;
      }

      // Set prettify toggle to current state
      if (prettifyToggle) {
        prettifyToggle.checked = this.storage.prettifyEnabled;
      }

      // Set dedupe toggle to current state
      if (dedupeToggle) {
        dedupeToggle.checked = this.storage.dedupeEnabled;
        modalLog.info('Setting dedupe checkbox to:', this.storage.dedupeEnabled);
      }

      // Set syntax highlight toggle to current state (now defaults to true)
      if (syntaxHighlightToggle) {
        syntaxHighlightToggle.checked = this.storage.syntaxHighlightEnabled;
        modalLog.info('Setting syntax highlight checkbox to:', this.storage.syntaxHighlightEnabled);
      }

      // Set code display settings
      if (expandThresholdInput) {
        expandThresholdInput.value = String(this.storage.expandThreshold);
      }
      if (maxLinesInput) {
        maxLinesInput.value = String(this.storage.maxLines);
      }
      if (fontSizeInput) {
        fontSizeInput.value = String(this.storage.codeFontSize);
      }

      if (messageConsoleLogToggle) {
        messageConsoleLogToggle.checked = this.storage.messageConsoleLogEnabled;
      }
      if (messageDebugBreakToggle) {
        messageDebugBreakToggle.checked = this.storage.messageDebugBreakEnabled;
      }
      if (messageDebugMatchInput) {
        messageDebugMatchInput.value = this.storage.messageDebugBreakMatch || '';
      }
      if (floodProtectionToggle) {
        floodProtectionToggle.checked = this.storage.floodProtectionEnabled;
      }
      if (maxCaptureSizeInput) {
        maxCaptureSizeInput.value = String(this.storage.messageMaxCaptureSize || 0);
      }

      modal.classList.add('show');
    });

    // Close settings modal
    const closeModal = (): void => {
      modal.classList.remove('show');

      // Reset input to original value when closing without saving
      if (urlInput) {
        urlInput.value = this.storage.originalLogUrl;
      }

      // Reset prettify toggle to original state
      if (prettifyToggle) {
        prettifyToggle.checked = this.storage.prettifyEnabled;
      }

      // Reset dedupe toggle to original state
      if (dedupeToggle) {
        dedupeToggle.checked = this.storage.dedupeEnabled;
      }

      // Reset syntax highlight toggle to original state (now defaults to true)
      if (syntaxHighlightToggle) {
        syntaxHighlightToggle.checked = this.storage.syntaxHighlightEnabled;
      }

      // Reset code display settings
      if (expandThresholdInput) {
        expandThresholdInput.value = String(this.storage.expandThreshold);
      }
      if (maxLinesInput) {
        maxLinesInput.value = String(this.storage.maxLines);
      }
      if (fontSizeInput) {
        fontSizeInput.value = String(this.storage.codeFontSize);
      }

      if (messageConsoleLogToggle) {
        messageConsoleLogToggle.checked = this.storage.messageConsoleLogEnabled;
      }
      if (messageDebugBreakToggle) {
        messageDebugBreakToggle.checked = this.storage.messageDebugBreakEnabled;
      }
      if (messageDebugMatchInput) {
        messageDebugMatchInput.value = this.storage.messageDebugBreakMatch || '';
      }
      if (floodProtectionToggle) {
        floodProtectionToggle.checked = this.storage.floodProtectionEnabled;
      }
      if (maxCaptureSizeInput) {
        maxCaptureSizeInput.value = String(this.storage.messageMaxCaptureSize || 0);
      }
    };

    if (cancelBtn) {
      cancelBtn.addEventListener('click', closeModal);
    }

    // Close modal when clicking outside
    modal.addEventListener('click', (e: MouseEvent) => {
      if (e.target === modal) {
        closeModal();
      }
    });

    // Save settings
    if (saveBtn) {
      saveBtn.addEventListener('click', () => {
        void (async () => {
          const logUrl = urlInput ? urlInput.value.trim() : '';
          await this.storage.saveLogUrl(logUrl);

          const prettifyEnabled = prettifyToggle ? prettifyToggle.checked : false;
          const prettifyChanged = prettifyEnabled !== this.storage.prettifyEnabled;
          await this.storage.savePrettifySetting(prettifyEnabled);

          // Handle syntax highlighting setting (now defaults to true)
          const syntaxHighlightEnabled = syntaxHighlightToggle ? syntaxHighlightToggle.checked : true;
          const syntaxHighlightChanged = syntaxHighlightEnabled !== this.storage.syntaxHighlightEnabled;
          if (syntaxHighlightChanged) {
            modalLog.info('Syntax highlight setting changed to:', syntaxHighlightEnabled);
            await this.storage.saveSyntaxHighlightSetting(syntaxHighlightEnabled);
          }

          // Handle dedupe setting
          const dedupeEnabled = dedupeToggle ? dedupeToggle.checked : true;
          const dedupeChanged = dedupeEnabled !== this.storage.dedupeEnabled;
          if (dedupeChanged) {
            modalLog.info('Dedupe setting changed to:', dedupeEnabled);
            await this.storage.saveDedupeSetting(dedupeEnabled);
          }

          // Handle code display settings
          let codeSettingsChanged = false;
          if (expandThresholdInput) {
            const newThreshold = parseInt(expandThresholdInput.value, 10) || 4000;
            if (newThreshold !== this.storage.expandThreshold) {
              this.storage.expandThreshold = newThreshold;
              codeSettingsChanged = true;
            }
          }
          if (maxLinesInput) {
            const newMaxLines = parseInt(maxLinesInput.value, 10) || 40;
            if (newMaxLines !== this.storage.maxLines) {
              this.storage.maxLines = newMaxLines;
              codeSettingsChanged = true;
            }
          }
          if (fontSizeInput) {
            const newFontSize = parseInt(fontSizeInput.value, 10) || 12;
            if (newFontSize !== this.storage.codeFontSize) {
              this.storage.codeFontSize = newFontSize;
              codeSettingsChanged = true;
            }
          }

          if (codeSettingsChanged) {
            this.storage.saveCodeSettings();
          }

          const messageConsoleLogEnabled = messageConsoleLogToggle ? messageConsoleLogToggle.checked : false;
          const messageDebugBreakEnabled = messageDebugBreakToggle ? messageDebugBreakToggle.checked : false;
          const messageDebugBreakMatch = messageDebugMatchInput ? messageDebugMatchInput.value.trim() : '';
          messageDebugMatchInput?.setCustomValidity('');
          if (messageDebugBreakMatch && messageDebugMatchInput) {
            const compiled = compileSafeRegex(messageDebugBreakMatch, 'i');
            if (!compiled.regex) {
              messageDebugMatchInput.setCustomValidity(
                `Rejected regex: ${compiled.error || 'Invalid regular expression.'}`
              );
              messageDebugMatchInput.reportValidity();
              return;
            }
            messageDebugMatchInput.setCustomValidity('');
          }
          const messageMaxCaptureSize = maxCaptureSizeInput
            ? Math.max(0, parseInt(maxCaptureSizeInput.value, 10) || 0)
            : this.storage.messageMaxCaptureSize;
          const messageDebugSettingsChanged =
            messageConsoleLogEnabled !== this.storage.messageConsoleLogEnabled ||
            messageDebugBreakEnabled !== this.storage.messageDebugBreakEnabled ||
            messageDebugBreakMatch !== this.storage.messageDebugBreakMatch ||
            messageMaxCaptureSize !== this.storage.messageMaxCaptureSize;

          if (messageDebugSettingsChanged) {
            await this.storage.saveMessageDebugSettings({
              consoleLogEnabled: messageConsoleLogEnabled,
              debugBreakEnabled: messageDebugBreakEnabled,
              debugBreakMatch: messageDebugBreakMatch,
              maxCapturedMessageSize: messageMaxCaptureSize
            });
          }

          const floodProtectionEnabled = floodProtectionToggle
            ? floodProtectionToggle.checked
            : this.storage.floodProtectionEnabled;
          if (floodProtectionEnabled !== this.storage.floodProtectionEnabled) {
            await this.storage.saveFloodProtectionSetting(floodProtectionEnabled);
          }

          // Clear prettify cache if setting changed
          if (prettifyChanged && this.onClearPrettifyCache) {
            this.onClearPrettifyCache();
          }

          // Refresh display to apply changes
          if (prettifyChanged || syntaxHighlightChanged || dedupeChanged || codeSettingsChanged) {
            // Determine if we need to force a full rebuild
            const needsFullRebuild = prettifyChanged || syntaxHighlightChanged;
            if (needsFullRebuild) {
              modalLog.info('Settings changed that affect syntax highlighting, doing full rebuild');
              if (this.onReHighlight) {
                this.onReHighlight(true);
              }
            } else {
              modalLog.info('Only non-highlighting settings changed, preserving existing highlighting');
              if (this.onReHighlight) {
                this.onReHighlight(false);
              }
            }

            if (this.onRefreshRequest) {
              await this.onRefreshRequest(false);
            }
          }

          modal.classList.remove('show');
        })();
      });
    }

    // Setup export/import functionality
    this.setupExportImport();
  }

  // Setup export/import functionality
  setupExportImport(): void {
    // Export URLs
    const exportUrlsBtn = document.getElementById('export-urls-btn');
    if (exportUrlsBtn) {
      exportUrlsBtn.addEventListener('click', () => {
        this.storage.exportBlockedUrls();
      });
    }

    // Import URLs
    const importUrlsBtn = document.getElementById('import-urls-btn');
    const importUrlsFile = document.getElementById('import-urls-file') as HTMLInputElement | null;
    if (importUrlsBtn && importUrlsFile) {
      importUrlsBtn.addEventListener('click', () => {
        importUrlsFile.click();
      });

      importUrlsFile.addEventListener('change', (e: Event) => {
        const input = e.target as HTMLInputElement | null;
        const file = input?.files?.[0];
        if (file) {
          this.storage.importBlockedUrls(file, (err: Error | null, message?: string) => {
            if (err) {
              alert('Error reading file: ' + err.message);
            } else {
              alert(message || 'Import completed');
              if (this.onRefreshRequest) {
                void this.onRefreshRequest(true);
              }
            }
          });
        }

        if (input) {
          input.value = ''; // Reset file input
        }
      });
    }

    // Clear URLs
    const clearUrlsBtn = document.getElementById('clear-urls-btn');
    if (clearUrlsBtn) {
      clearUrlsBtn.addEventListener('click', () => {
        void (async () => {
          if (confirm('Are you sure you want to clear all blocked URLs?')) {
            this.storage.clearBlockedUrls();
            alert('All blocked URLs cleared');
            if (this.onRefreshRequest) {
              await this.onRefreshRequest(true);
            }
          }
        })();
      });
    }

    // Export listeners
    const exportListenersBtn = document.getElementById('export-listeners-btn');
    if (exportListenersBtn) {
      exportListenersBtn.addEventListener('click', () => {
        this.storage.exportBlockedListeners();
      });
    }

    // Import listeners
    const importListenersBtn = document.getElementById('import-listeners-btn');
    const importListenersFile = document.getElementById('import-listeners-file') as HTMLInputElement | null;
    if (importListenersBtn && importListenersFile) {
      importListenersBtn.addEventListener('click', () => {
        importListenersFile.click();
      });

      importListenersFile.addEventListener('change', (e: Event) => {
        const input = e.target as HTMLInputElement | null;
        const file = input?.files?.[0];
        if (file) {
          this.storage.importBlockedListeners(file, (err: Error | null, message?: string) => {
            if (err) {
              alert('Error reading file: ' + err.message);
            } else {
              alert(message || 'Import completed');
              if (this.onRefreshRequest) {
                void this.onRefreshRequest(true);
              }
            }
          });
        }

        if (input) {
          input.value = ''; // Reset file input
        }
      });
    }

    // Clear listeners
    const clearListenersBtn = document.getElementById('clear-listeners-btn');
    if (clearListenersBtn) {
      clearListenersBtn.addEventListener('click', () => {
        void (async () => {
          if (confirm('Are you sure you want to clear all blocked listeners?')) {
            this.storage.clearBlockedListeners();
            alert('All blocked listeners cleared');
            if (this.onRefreshRequest) {
              await this.onRefreshRequest(true);
            }
          }
        })();
      });
    }
  }
}

(globalThis as unknown as { PanelModals: typeof PanelModals }).PanelModals = PanelModals;
