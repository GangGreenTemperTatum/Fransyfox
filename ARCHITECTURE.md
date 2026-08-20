# Fransceiver Architecture Documentation

## Overview

Fransceiver is a Manifest V3 Chrome extension designed for security researchers and developers to track, analyze, and understand `postMessage` communication patterns on web pages. It intercepts `addEventListener` calls for message events, captures message traffic, and provides security analysis through configurable rules.

## Firefox

The same codebase builds for Firefox 128+ (`dist/firefox/`). Differences:

- The panel opens in the Firefox **sidebar** (`sidebar_action`) instead of Chrome's side panel; `src/shared/browser-env.ts` adapts between `chrome.sidePanel` and `browser.sidebarAction`.
- Firefox runs the background as an **event page** (`background.scripts`); Chrome runs the same script as a service worker.
- `chrome.devtools.panels.openResource` is unsupported in Firefox and is feature-guarded in `devtools.ts`.
- MAIN-world content scripts require Firefox 128+ (`scripting` API `world: "MAIN"`).

## Architecture Diagram

```
+-----------------------------------------------------------------------------------+
|                              CHROME BROWSER                                        |
+-----------------------------------------------------------------------------------+
|                                                                                   |
|  +-----------------------+     +-------------------------+     +---------------+  |
|  |    WEB PAGE           |     |    EXTENSION PANEL      |     | SERVICE       |  |
|  |    (MAIN World)       |     |    (Extension Context)  |     | WORKER        |  |
|  +-----------------------+     +-------------------------+     +---------------+  |
|  |                       |     |                         |     |               |  |
|  |  +---------------+    |     |  panel.html             |     | background.js |  |
|  |  | main.js       |    |     |  panel-main.js          |     |               |  |
|  |  | (Prototype    |    |     |  panel-ui.js            |     | - State mgmt  |  |
|  |  |  hooks)       |    |     |  panel-ui-messages.js   |     | - Persistence |  |
|  |  +-------+-------+    |     |  panel-ui-findings.js   |     | - Findings    |  |
|  |          |            |     |  panel-modals.js        |     |               |  |
|  |          |            |     |  panel-storage.js       |     |               |  |
|  |          |            |     +------------+------------+     +-------+-------+  |
|  |          | window.    |                  |                          |          |
|  |          | postMessage|                  | chrome.runtime.connect   |          |
|  |          v            |                  | (Port Communication)     |          |
|  |  +---------------+    |                  v                          |          |
|  |  | bridge.js     |----+------------------>--------------------------+          |
|  |  | (ISOLATED     |    |     chrome.runtime.sendMessage              |          |
|  |  |  World)       |<---+<--------------------------------------------+          |
|  |  +---------------+    |                                                        |
|  |                       |                                                        |
|  +-----------------------+                                                        |
|                                                                                   |
+-----------------------------------------------------------------------------------+
                                        |
                                        v
                              +-------------------+
                              | chrome.storage    |
                              | (Persistence)     |
                              +-------------------+
```

## Component Details

### 1. Content Scripts

#### main.js (MAIN World)
**Purpose**: Intercepts JavaScript APIs at the prototype level to capture `postMessage` listener registrations and message traffic.

**Key Responsibilities**:
- Hooks `Window.prototype.addEventListener` to capture message listeners
- Hooks `MessagePort.prototype.addEventListener` for MessageChannel communication
- Hooks `window.onmessage` setter for inline handler assignment
- Hooks `Window.prototype.postMessage` and `MessagePort.prototype.postMessage` for match/replace functionality
- Hooks `History.prototype.pushState` to track SPA navigation
- Unwraps error monitoring wrappers (Sentry, Raven, NewRelic, Rollbar, Bugsnag)
- Filters extension-originated messages using blacklist patterns
- Applies match/replace rules for message modification (security testing feature)

**Key Patterns**:
```javascript
// Prototype hooking pattern
const originalAddEventListener = Window.prototype.addEventListener;
Window.prototype.addEventListener = function(type, listener, useCapture) {
    if (type == 'message') {
        // Capture listener details and send to bridge
        l(listener, pattern_before, offset);
    }
    return originalAddEventListener.call(this, type, listener, useCapture);
};
```

**Limitations**:
- Cannot import extension modules (runs in page's JavaScript context)
- Receives shared constants (e.g., blacklist) via injection from bridge.js
- Prototype modifications can break websites if not careful

#### bridge.js (ISOLATED World)
**Purpose**: Acts as a secure communication bridge between the MAIN world (main.js) and the extension's service worker.

**Key Responsibilities**:
- Injects shared constants (e.g., `EXTENSION_BLACKLIST`) into main.js at initialization
- Receives messages from main.js via `window.postMessage`
- Forwards listener data to background.js via `chrome.runtime.sendMessage`
- Receives rule updates from service worker and forwards to main.js
- Handles page navigation tracking (`beforeunload` event)

**Message Flow**:
```
main.js --[window.postMessage]--> bridge.js --[chrome.runtime.sendMessage]--> background.js
main.js <--[window.postMessage]-- bridge.js <--[chrome.runtime.onMessage]-- background.js
```

### 2. Service Worker (background.js)

**Purpose**: Central state management, data persistence, and message routing.

**Key Responsibilities**:
- Maintains listener data per tab (`tab_listeners`, `tab_listener_keys`)
- Persists state to `chrome.storage.local` across service worker restarts
- Deduplicates listeners using Set-based key tracking
- Applies security findings rules to detected listeners
- Broadcasts settings updates to all tabs
- Manages badge count display
- Handles port connections from the panel
- External logging to configurable endpoints

**State Management Pattern**:
```javascript
class PersistentState {
    constructor() {
        this.isLoaded = false;
        this.loadPromise = this.loadState();
    }
    // Debounced save to avoid excessive storage writes
    debouncedSave = this.debounce(this.saveState.bind(this), 100);
}
```

**Initialization Pattern**:
```javascript
// Combined promise ensures all handlers wait for complete initialization
const initPromise = Promise.all([
    persistentState.loadPromise,  // Listener data loaded
    settingsLoadedPromise          // Settings loaded
]);

// Every handler must await initPromise
chrome.runtime.onMessage.addListener(function(msg, sender, sendResponse) {
    (async () => {
        await initPromise;  // Critical: wait for state
        // Handle message
    })();
    return true;
});
```

### 3. Popup (Modular Architecture)

**Purpose**: User interface for viewing and managing detected listeners, messages, and findings.

**Architecture**:
```
panel-main.js (Controller)
    |
    +-- PopupStorage (panel-storage.js)
    |       - Manages chrome.storage interactions
    |       - Handles blocklists, settings, regex patterns
    |
    +-- PopupModals (panel-modals.js)
    |       - Regex editor modal
    |       - Highlight editor modal
    |       - Settings modal
    |       - Export/Import functionality
    |
    +-- PanelUI (panel-ui.js)
            |
            +-- PanelUIMessages (panel-ui-messages.js)
            |       - Messages tab rendering
            |       - Message formatting
            |       - PostMessage snippet generation
            |
            +-- PanelUIFindings (panel-ui-findings.js)
                    - Findings tab rendering
                    - Findings filtering
                    - Listener context formatting
```

**File Breakdown**:
| File | Purpose |
|------|---------|
| `panel.html` | UI structure and script loading |
| `panel-main.js` | Controller, state management, event handling |
| `panel-ui.js` | Core DOM manipulation, listeners tab, syntax highlighting |
| `panel-ui-messages.js` | Messages tab rendering |
| `panel-ui-findings.js` | Findings tab rendering |
| `panel-modals.js` | Modal dialogs (regex, highlight, settings) |
| `panel-storage.js` | Chrome storage abstraction |
| `panel.css` | Base styles, layout, tabs |
| `panel-modals.css` | Modal-specific styles |

**Key Features**:
- **Listeners Tab**: View detected `postMessage` listeners with blocking/unblocking
- **Messages Tab**: View captured message traffic with filtering
- **Findings Tab**: View security analysis results from automated rules
- **Match/Replace Tab**: Configure message modification rules for testing

**Port Communication**:
```javascript
this.port = chrome.runtime.connect({ name: "Fransceiver Communication" });
this.port.onMessage.addListener((msg) => this.handleBackgroundMessage(msg));
// Automatic reconnection on disconnect
this.port.onDisconnect.addListener(() => {
    setTimeout(() => this.connectPort(), 100);
});
```

### 4. Shared Modules (shared/)

#### constants.js
- Storage key constants
- Extension blacklist patterns (canonical source)
- Content type constants

#### url-utils.js
- URL cleaning (strips query params, fragments)
- JavaScript URL extraction from stack traces

#### messages.js
- Port message type constants (`REQUEST_STATE`, `STATE`, `REQUEST_EVENTS`, etc.)

#### logger.js
- Scoped logging utility with configurable levels
- Consistent log prefixing

#### event-store.js
- Circular buffer implementation for message event storage
- Memory-efficient bounded collection

#### findings.js
- Security analysis rules engine
- Evaluates listeners for common vulnerabilities:
  - Missing origin checks
  - Unescaped dots in origin regex
  - Missing end anchors in origin regex
  - eval/Function on message data
  - DOM sinks (innerHTML, etc.) on message data
  - Location assignment from message data
  - postMessage with wildcard target
  - Missing data type guards

## Data Flow Diagrams

### Listener Detection Flow
```
Web Page loads
    |
    v
main.js hooks Window.prototype.addEventListener
    |
    v
App calls window.addEventListener('message', handler)
    |
    v
main.js intercepts call
    |
    +-- Unwrap error monitoring wrappers
    +-- Check extension blacklist
    +-- Extract stack trace
    +-- Capture listener code
    |
    v
Send to bridge.js via window.postMessage
    |
    v
bridge.js forwards to background.js via chrome.runtime.sendMessage
    |
    v
background.js processes:
    +-- Check for duplicates
    +-- Apply security findings rules
    +-- Store in tab_listeners
    +-- Persist to storage
    +-- Update badge count
    +-- Notify connected panels
```

### Message Capture Flow
```
External frame/window calls postMessage()
    |
    v
Browser delivers MessageEvent
    |
    v
main.js captures via registered 'message' listener
    |
    +-- Check extension blacklist
    +-- Apply match/replace rules
    +-- Normalize data
    |
    v
Emit to bridge.js as POSTMESSAGE_TRACKER_EVENT
    |
    v
bridge.js forwards to background.js
    |
    v
background.js adds to eventStore (circular buffer)
    |
    v
Popup requests events via port message
```

### State Persistence Model
```
+--------------------+     +------------------------+
|   Memory State     |     |   chrome.storage.local |
+--------------------+     +------------------------+
| tab_listeners      |<--->| tab_listeners          |
| tab_listener_keys  |<--->| tab_listener_keys      |
| (Sets as arrays)   |     | (arrays)               |
+--------------------+     +------------------------+
| tab_push           |     | NOT persisted          |
| tab_lasturl        |     | (navigation state)     |
+--------------------+     +------------------------+

Settings (always in storage):
- dedupeEnabled
- blockedListeners
- blockedUrls
- blockedRegex
- matchReplaceRules
- highlightRules
- log_url
- codeFontSize, expandThreshold, maxLines
- syntaxHighlightEnabled, prettifyEnabled
```

## Security Features

### Origin Validation Analysis
The findings engine detects common origin validation mistakes:

```javascript
// Rule: origin-regex-unescaped-dot
// Detects: /example.com/.test(origin)
// Risk: Matches exampleXcom, example\ncom, etc.

// Rule: origin-regex-missing-anchor
// Detects: /example\.com/.test(origin)
// Risk: Matches example.com.evil.com
```

### Dangerous Sink Detection
```javascript
// Detects: eval(event.data)
// Detects: innerHTML = event.data
// Detects: location.href = event.data
```

### Listener Blocking
Three blocking mechanisms:
1. **Exact match**: Block specific listener code
2. **URL-based**: Block all listeners from a JavaScript file
3. **Regex patterns**: Block listeners matching custom patterns

## Performance Optimizations

### Circular Buffer for Events
```javascript
// Avoids array.slice() which creates new arrays on overflow
const buffer = new Array(maxEvents);
let head = 0;  // Next write position
let count = 0; // Events stored
```

### Data Version Tracking
```javascript
// Avoids expensive JSON.stringify comparisons
let dataVersion = 0;
// Increment only when data changes
cachedPopupData.dataVersion++;
// Popup compares versions instead of full data
```

### Debounced Storage Writes
```javascript
debouncedSave = this.debounce(this.saveState.bind(this), 100);
```

### DOM Element Caching
```javascript
this.domCache = {
    container: document.getElementById('x'),
    // ... cached on init, not queried repeatedly
};
```

## Extension Permissions

```json
{
    "permissions": ["tabs", "storage"],
    "host_permissions": ["*://*/*"]
}
```

- **tabs**: Required to get active tab info and update badge
- **storage**: Required for state persistence
- **host_permissions (*://*/*)**: Required to inject content scripts on all sites (core functionality)

## File Summary

| File | Lines | Purpose |
|------|-------|---------|
| manifest.json | 44 | Extension configuration |
| background.js | 864 | Service worker, state management |
| main.js | 682 | MAIN world prototype hooks |
| bridge.js | 105 | ISOLATED world bridge |
| panel.html | ~285 | Popup UI structure |
| panel-main.js | ~1036 | Popup controller |
| panel-ui.js | ~1156 | Core DOM/rendering |
| panel-ui-messages.js | ~252 | Messages tab rendering |
| panel-ui-findings.js | ~293 | Findings tab rendering |
| panel-modals.js | ~565 | Modal dialogs |
| panel-storage.js | 527 | Popup storage operations |
| panel.css | ~1069 | Base panel styling |
| panel-modals.css | ~438 | Modal styles |
| shared/constants.js | 40 | Shared constants |
| shared/url-utils.js | 48 | URL utilities |
| shared/messages.js | 17 | Message constants |
| shared/logger.js | 51 | Logging utility |
| shared/event-store.js | 73 | Circular buffer |
| shared/findings.js | 303 | Security rules engine |

## Key Gotchas for Developers

1. **Service Worker Termination**: Don't rely on global variables. Always restore from storage.

2. **MAIN World Isolation**: main.js cannot import extension modules. Use bridge.js to inject shared constants via postMessage.

3. **Async Response Pattern**: Always return `true` from `onMessage` listeners for async responses.

4. **Error Handling for sendMessage**: In MV3, `chrome.tabs.sendMessage` returns a Promise. Use `.catch()`.

5. **Prototype Hooks Risk**: Modifying `Window.prototype` can break websites. Test carefully. Always add console.warn logging in catch blocks.

6. **Navigation State**: Don't persist `tab_push`/`tab_lasturl` - causes duplicate listener bugs on service worker restart.

7. **Settings vs Data**: Both must be loaded before handlers execute. Use combined `initPromise`.

8. **Port Listener Cleanup**: Store listener functions as named references. Anonymous listeners can't be removed, causing duplicates on reconnect.

9. **Debounce Expensive Operations**: Operations triggered by storage changes (e.g., regex compilation) should be debounced to batch rapid user edits.

10. **Run Detection Once**: Use flags to prevent redundant detection work on repeated events (e.g., jQuery detection on every postMessageTrackerUpdate).

11. **Listener Payload Contract**: `main.ts` emits listener captures as raw records (top-level `listener`, `stack`, etc.), `bridge.ts` forwards `detail` directly via `chrome.runtime.sendMessage`, and `background.ts` parses that runtime message. If `parseRuntimeRequestMessage` stops accepting this raw shape, listeners disappear while message events may still work.

## Refactor Regression Matrix (TS + Vite)

Use this matrix after each migration step to verify parity between `assets/` (sources) and `dist/chrome/` / `dist/firefox/` (outputs).

| Area | Scenario | Expected Result |
|------|----------|-----------------|
| Listener capture | Top window and iframe listeners register on load | Listener rows appear with domain/hops/stack metadata |
| Findings engine | Listener without origin check is detected | Findings tab shows `missing-origin-check` |
| Message capture | Page emits `postMessage` events | Messages tab receives source/target/origin/data |
| Blocking | Block by listener/url/regex | Blocked listeners are excluded from active listener count |
| Match/Replace | Save valid rule and trigger outbound message | Payload is rewritten according to saved rule order |
| Panel sync | Open, close, and reopen panel quickly | Port reconnects without duplicate message listeners |
| Active toggle | Disable then re-enable extension | Content scripts unregister/register and badge updates |
| Persistence | Restart browser and resume session | Listener data/settings restore from storage |

## Phase 2 Contract Layer

The TS migration now enforces message/state boundaries through explicit contract modules:

- `src/contracts/messages.ts`
  - Parses and validates runtime messages (`chrome.runtime.sendMessage`)
  - Parses and validates port request/response payloads
  - Parses and validates bridge `window.postMessage` payloads
  - Must accept raw listener payloads forwarded from bridge `POSTMESSAGE_TRACKER_DATA.detail`
- `src/contracts/state.ts`
  - Normalizes booleans/strings/arrays read from storage
  - Normalizes match/replace rule shape
  - Normalizes message debug settings
  - Normalizes listener record shape

These contracts are used directly in:
- `src/background.ts` (runtime + port message ingress, storage normalization)
- `src/bridge.ts` (bridge message ingress)
- `src/main.ts` (bridge message ingress)
- `src/PanelMain.ts` (port response ingress)
- `src/panel-storage.ts` (storage value normalization)
