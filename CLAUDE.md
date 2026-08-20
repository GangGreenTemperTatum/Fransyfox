# Fransceiver - Cross-Browser postMessage Tracker

Manifest V3 browser extension that tracks and analyzes `postMessage` listeners
and messages on web pages. Ships for Chrome/Chromium (side panel) and
Firefox 128+ (extension sidebar). Designed for security researchers to
understand cross-frame communication patterns.

Tribute to Frans Rosén's [postMessage-tracker](https://github.com/fransr/postMessage-tracker).
Downstream-of-downstream: postMessage-tracker → FancyTracker → FransyTracker → Fransceiver.

## Project Structure

```
assets/
├── manifest.json          # Chrome MV3 manifest (side panel)
├── manifest.firefox.json  # Firefox MV3 manifest (sidebar_action, gecko id)
├── panel.html             # Extension panel UI (loaded in side panel / sidebar)
├── panel.css              # Base panel styles
├── panel-modals.css       # Modal-specific styles
├── devtools.html          # DevTools page (openResource bridge)
├── lib/                   # Third-party libraries (highlight.js)
└── icons/                 # Extension icons

src/
├── background.ts          # Service worker / event page - state, routing, persistence
├── main.ts                # MAIN world content script - prototype hooks
├── bridge.ts              # ISOLATED world - bridges main world to background
├── devtools.ts            # DevTools page driver
├── panel-*.ts             # Panel controller, UI, storage, modals, sub-views
├── shared/                # Shared modules + browser-env adapter
├── types/                 # TypeScript contracts/types
└── contracts/             # Runtime message/state parsers and normalizers

scripts/
├── build.mjs              # Builds dist/chrome/ and dist/firefox/
└── e2e/                   # Firefox end-to-end harness + fixture page
```

Runtime JavaScript is built from `src/` into `dist/chrome/` and
`dist/firefox/`. `assets/` is only static files.

## Key Architecture Patterns

### Dual Content Script Pattern
- **main.js** runs in the page's MAIN world and hooks
  `Window.prototype.addEventListener`, `postMessage`,
  `MessagePort.prototype.*`, `History.prototype.pushState`, etc.
  (requires Firefox 128+ for `world: "MAIN"` via the `scripting` API).
- **bridge.js** runs in the ISOLATED world and talks to the service worker.
- MAIN ↔ ISOLATED communication uses document `CustomEvent`s
  (`fransceiver:to-bridge` / `fransceiver:to-main`) whose detail is a JSON
  string, so tracker traffic never appears as page `message` events.

### Background (service worker / event page)
- Chrome: `background.service_worker`. Firefox: `background.scripts`
  (event page). State does not survive restarts - persist via storage.
- `initPromise` gates every handler until persistent state + settings load.
- State version tracking (`dataVersion`) avoids serialized comparisons.
- Listener data persists in `storage.local`; message events live in an
  IndexedDB-backed persistent event store.

### Browser surface adapter (`src/shared/browser-env.ts`)
- `chrome.sidePanel` (Chrome) and `browser.sidebarAction` (Firefox) are
  wrapped behind `getPanelSurfaceKind()` / `openPanelSurface()` etc.
- Never call `chrome.sidePanel.*` directly outside this module.

### Self-identity / blacklists
- Own envelopes use the `FRANSCEIVER_*` protocol types.
- `EXTENSION_BLACKLIST` keeps legacy tokens (`event-tracker*`,
  `POSTMESSAGE_TRACKER_*`, `FransyTracker:`) so old tracker instances stay
  silent - keep those tokens when editing.

## Development Notes

### Build
- `npm run build` - emits `dist/chrome/` and `dist/firefox/`
- `npm run dev` / `npm run dev:all` - watch rebuilds
- `npm run typecheck` / `npm run lint` / `npm run test`

### Firefox specifics
- Panel lives in the Firefox sidebar (`sidebar_action`), toggled by the
  action button; it follows the active tab via `tabs.onActivated`.
- `chrome.devtools.panels.openResource` does not exist in Firefox - the
  devtools driver answers `{success: false}` there. Guarded in `devtools.ts`.
- Keep `manifest.firefox.json` in sync with `manifest.json` (permissions,
  version). Gecko id: `fransceiver@GangGreenTemperTatum.github.io` (change before AMO publish).

### E2E (Firefox)
- `npm run e2e:firefox` runs `scripts/e2e/firefox_e2e.py`: installs the
  built add-on into a real Firefox and verifies the full pipeline
  (MAIN-world injection → listener capture → message events → port protocol →
  panel UI). Artifacts: `scripts/e2e/artifacts/`.
- Release Firefox enforces add-on signing; use Firefox Developer Edition or
  Nightly locally (`FIREFOX_BIN=...`). CI uses Nightly.

## Common Gotchas

- **Service worker globals**: never rely on them - use storage.
- **MAIN world isolation**: `main.js` cannot use extension APIs; talk through
  the bridge. Prototype hooks can break sites - test carefully.
- **`chrome.tabs.sendMessage`** returns a promise in MV3 - use `.catch()`.
- **Startup activation race**: main/bridge default to ACTIVE at
  `document_start` (scripts only exist while the extension is active);
  deactivation still propagates via broadcasts. Do not re-introduce an
  async activation gate for the initial state.
- **Cold-started background**: `addListener` marks the tab as loaded
  (`tab_lasturl`) to avoid a late `tabs.onUpdated 'loading'` event wiping
  just-captured listeners.

## Code Review Learnings (from the FransyTracker lineage)

1. Never trust global state in the service worker; always init from storage.
2. Version counters beat JSON.stringify for change detection.
3. Debounce storage writes and expensive broadcasts.
4. Store bound port listeners as fields; clean up before reconnecting.
5. Circular buffers for bounded event collections.
6. Prototype hooks need defensive try/catch + logging.
7. Legacy envelope tokens in blacklists keep old tracker installs quiet.

## Known Intentional Choices

1. **`*://*/*` host permissions** - required to intercept postMessages on all sites.
2. **MAIN world prototype hooks** - required to intercept `addEventListener`/`postMessage`.
3. **Match/replace** - actively modifies message payloads while enabled.