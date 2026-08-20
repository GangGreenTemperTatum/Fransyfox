// DevTools page script for Fransceiver.
// Handle one-shot openResource requests so service-worker restarts cannot lose
// the knowledge that DevTools is open for this tab.
chrome.runtime.onMessage.addListener((msg: unknown, _sender, sendResponse) => {
  if (
    typeof msg === 'object' &&
    msg !== null &&
    (msg as Record<string, unknown>).action === 'openResourceInDevtools' &&
    (msg as Record<string, unknown>).tabId === chrome.devtools.inspectedWindow.tabId
  ) {
    const { url, line, column } = msg as { url: string; line: number; column: number };
    const panels = chrome.devtools && chrome.devtools.panels;
    if (!panels || typeof panels.openResource !== 'function') {
        sendResponse({ success: false, error: 'Opening resolution targets in DevTools is not supported by this browser' });
        return true;
    }
    // openResource uses 0-indexed lines, stack traces are 1-indexed
    chrome.devtools.panels.openResource(url, line - 1, column ?? 0, () => {
      const error = chrome.runtime.lastError;
      sendResponse(error
        ? { success: false, error: error.message }
        : { success: true });
    });
    return true;
  }
  return false;
});
