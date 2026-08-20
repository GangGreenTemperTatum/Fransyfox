# Fransyfox Smoke Checklist

Run this checklist before and after migration steps to confirm behavior parity.

1. Listener detection
- Open a page that registers `window.addEventListener('message', ...)`.
- Confirm listeners appear in the panel Listeners tab.

2. Findings generation
- Use a listener that reads `event.data` without `event.origin` checks.
- Confirm Findings tab reports `missing-origin-check`.

3. Message capture
- Trigger `window.postMessage(...)` from the page console.
- Confirm Messages tab updates with source/target/origin details.

4. Blocking flows
- Block listener by code, URL, and regex.
- Confirm active count excludes blocked listeners.

5. Match/replace
- Save a match/replace rule in the panel.
- Trigger outbound message and confirm payload rewrite.

6. Active toggle
- Disable extension from the panel settings.
- Confirm listener capture stops.
- Re-enable and confirm capture resumes.

7. Popup reconnect
- Open/close panel repeatedly.
- Confirm no duplicate updates or stale port errors.

8. Persistence
- Reload extension/service worker and reopen panel.
- Confirm listeners/settings survive restart from storage.
