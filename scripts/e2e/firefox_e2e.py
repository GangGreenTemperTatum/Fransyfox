#!/usr/bin/env python3
"""Fransceiver Firefox end-to-end test.

Launches a real Firefox with the built add-on (dist/firefox) installed as a
temporary add-on, serves a fixture page that registers postMessage listeners
and posts messages, then verifies the full pipeline end-to-end:

  1. MAIN-world content script injection (window.FransceiverMainLoaded)
  2. Listener capture: page listener -> main world hook -> bridge ->
     service worker -> panel port protocol (REQUEST_STATE)
  3. Message capture: page postMessage -> bridge batching -> service worker
     event store -> panel port protocol (REQUEST_EVENTS)
  4. Frame tree (REQUEST_FRAME_TREE)
  5. Panel UI loads in an extension page context
  6. Deduplication: double registration of the same listener collapses to one
  7. Match & Replace: storage rule -> SW broadcast -> bridge -> MAIN world
     payload splicing is observed in captured message events
  8. Persistence: listener state survives an extension reload
     (chrome.runtime.reload)

Requirements:
  - Firefox Developer Edition or Nightly (release builds enforce add-on
    signing). Set FIREFOX_BIN to the binary.
  - geckodriver on PATH (set GECKODRIVER_PATH to override)
  - Python 3 with selenium installed

Artifacts (screenshots, add-on zip) are written to scripts/e2e/artifacts/.
"""

import functools
import http.server
import os
import shutil
import socketserver
import sys
import threading
import time
import zipfile
from pathlib import Path

from selenium import webdriver
from selenium.webdriver.firefox.options import Options

SCRIPT_DIR = Path(__file__).resolve().parent
ROOT = SCRIPT_DIR.parents[1]
DIST_FIREFOX = ROOT / "dist" / "firefox"
FIXTURE = SCRIPT_DIR / "fixture.html"
ARTIFACTS = SCRIPT_DIR / "artifacts"

MARKER = "frx-e2e-%d" % int(time.time() * 1000)

FAILURES = []


def log(message):
    print("[e2e] %s" % message, flush=True)


def fail(message):
    FAILURES.append(message)
    log("FAIL: %s" % message)


def check(condition, message):
    if condition:
        log("PASS: %s" % message)
    else:
        fail(message)


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


def serve(directory):
    handler = functools.partial(QuietHandler, directory=str(directory))
    httpd = socketserver.TCPServer(("127.0.0.1", 0), handler)
    port = httpd.server_address[1]
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd, port


def find_firefox_binary():
    env_bin = Path(os.environ.get("FIREFOX_BIN", "") or "")
    if env_bin.is_file():
        return str(env_bin)
    candidates = [
        "/Applications/Firefox.app/Contents/MacOS/firefox",
        "/Applications/Firefox Developer Edition.app/Contents/MacOS/firefox",
        "/usr/bin/firefox",
        "/usr/bin/firefox-esr",
    ]
    for candidate in candidates:
        if Path(candidate).is_file():
            return candidate
    found = shutil.which("firefox")
    if found:
        return found
    raise FileNotFoundError(
        "Firefox binary not found. Set FIREFOX_BIN to the firefox executable."
    )


def find_geckodriver():
    env_path = os.environ.get("GECKODRIVER_PATH", "")
    if env_path and Path(env_path).is_file():
        return env_path
    found = shutil.which("geckodriver")
    if found:
        return found
    raise FileNotFoundError(
        "geckodriver not found. Set GECKODRIVER_PATH to the executable."
    )


def make_addon_zip():
    zip_path = ARTIFACTS / "fransceiver-e2e.zip"
    zip_path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as archive:
        for path in sorted(DIST_FIREFOX.rglob("*")):
            if path.is_file():
                archive.write(path, path.relative_to(DIST_FIREFOX))
    return zip_path


def poll(driver, script, predicate, timeout_s, interval=0.5, label=""):
    deadline = time.time() + timeout_s
    last = None
    while time.time() < deadline:
        try:
            last = driver.execute_script(script)
            if predicate(last):
                return last
        except Exception as exc:  # noqa: BLE001
            last = "error: %r" % exc
        time.sleep(interval)
    log("%s final value: %r" % (label, last))
    return last


def extension_uuid(driver):
    driver.get("about:debugging#/runtime/this-firefox")
    script = """
    var candidates = Array.from(document.querySelectorAll('li, section, div'))
      .filter(function (el) {
        var text = el.textContent || '';
        return text.indexOf('Fransceiver') !== -1 && text.indexOf('Manifest URL') !== -1;
      })
      .sort(function (a, b) {
        return (a.textContent || '').length - (b.textContent || '').length;
      });
    for (var i = 0; i < candidates.length; i++) {
      var link = candidates[i].querySelector('a[href^="moz-extension://"]');
      if (link) {
        return link.href;
      }
    }
    return '';
    """
    end = time.time() + 20
    while time.time() < end:
        try:
            href = driver.execute_script(script) or ""
        except Exception:  # noqa: BLE001
            href = ""
        if href.startswith("moz-extension://") and href.endswith("/manifest.json"):
            uuid = href.split("/")[2]
            log("extension internal uuid: %s" % uuid)
            return uuid
        time.sleep(1)
    raise RuntimeError(
        "Could not find the temporary add-on UUID in about:debugging"
    )


def fixture_ready(driver, url):
    driver.get(url)
    end = time.time() + 15
    state = {"loaded": False, "posted": 0}
    while time.time() < end:
        try:
            state = driver.execute_script(
                "return {loaded: window.FransceiverMainLoaded === true,"
                " posted: (window.__frxE2E || {}).messagesPosted || 0};"
            )
        except Exception:  # noqa: BLE001
            state = {"loaded": False, "posted": 0}
        if state["loaded"] and state["posted"] >= 6:
            return state
        time.sleep(0.5)
    return state


HARNESS_PREAMBLE = """
        function request(port, payload) {
          return new Promise(function (resolve, reject) {
            var timer = setTimeout(function () {
              reject(new Error('timeout waiting for ' + payload.expect));
            }, 15000);
            function listener(msg) {
              if (msg && msg.type === payload.expect &&
                  !(typeof payload.tabId === 'number' && msg.tabId !== payload.tabId)) {
                clearTimeout(timer);
                port.onMessage.removeListener(listener);
                resolve(msg);
              }
            }
            port.onMessage.addListener(listener);
            port.postMessage(payload);
          });
        }

        async function fixtureTabId() {
          var tabs = await chrome.tabs.query({});
          var fixtureTab = tabs.find(function (t) {
            return typeof t.url === 'string' && t.url.indexOf('fixture.html') !== -1;
          });
          if (!fixtureTab) {
            throw new Error('fixture tab not found among ' + tabs.length + ' tabs');
          }
          return fixtureTab.id;
        }

        async function withPort(fn) {
          var port = chrome.runtime.connect({ name: 'e2e-harness' });
          try {
            return await fn(port);
          } finally {
            try { port.disconnect(); } catch (e) {}
          }
        }
"""


def panel_harness(body):
    return (
        "var done = arguments[arguments.length - 1];\n"
        "var marker = arguments[0];\n"
        "function finish(result) { try { done(result); } catch (e) {} }\n"
        "(async function () {\n"
        + HARNESS_PREAMBLE
        + body
        + "\n})().then(\n"
        "  function (result) { finish(result); },\n"
        "  function (error) { finish({ error: String((error && error.stack) || error) }); }\n"
        ");"
    )


STATE_BODY = """
        return await withPort(async function (port) {
          var tabId = await fixtureTabId();
          var state = await request(port, { type: 'REQUEST_STATE', tabId: tabId, expect: 'STATE' });
          var events = await request(port, { type: 'REQUEST_EVENTS', expect: 'EVENTS' });
          var tree = await request(port, { type: 'REQUEST_FRAME_TREE', tabId: tabId, expect: 'FRAME_TREE' });

          var listenerText = (state.listeners || []).map(function (l) {
            return (l.listener || '') + ' ' + (l.stack || '') + ' ' +
                   (JSON.stringify(l.hops || ''));
          }).join(' ');

          var matchedMessages = (events.events || []).filter(function (e) {
            return (e.dataText || '').indexOf(marker) !== -1;
          });

          return {
            tabId: tabId,
            extensionActive: state.extensionActive,
            listenerCount: (state.listeners || []).length,
            probeDetected: listenerText.indexOf('frxProbeListener') !== -1,
            frameCount: (tree.frames || []).length,
            eventCount: (events.events || []).length,
            matchedMessages: matchedMessages.length,
            matchedHasTabId: matchedMessages.some(function (e) {
              return e.tabId === tabId;
            })
          };
        });
"""

DEDUPE_BODY = """
        return await withPort(async function (port) {
          var tabId = await fixtureTabId();
          var state = await request(port, { type: 'REQUEST_STATE', tabId: tabId, expect: 'STATE' });
          var dedupeCount = (state.listeners || []).filter(function (l) {
            return (l.listener || '').indexOf('frxDedupeProbe') !== -1;
          }).length;
          var probeCount = (state.listeners || []).filter(function (l) {
            return (l.listener || '').indexOf('frxProbeListener') !== -1;
          }).length;
          return { dedupeCount: dedupeCount, probeCount: probeCount };
        });
"""

SECRET_EVENTS_BODY = """
        return await withPort(async function (port) {
          var events = await request(port, { type: 'REQUEST_EVENTS', expect: 'EVENTS' });
          var secret = 'secret-' + marker;
          var spliced = (events.events || []).filter(function (e) {
            return (e.dataText || '').indexOf('"frxSecret":"REDACTED"') !== -1;
          });
          var leaked = (events.events || []).filter(function (e) {
            return (e.dataText || '').indexOf(secret) !== -1;
          });
          return { spliced: spliced.length, leaked: leaked.length };
        });
"""

PERSIST_BODY = """
        return await withPort(async function (port) {
          var tabId = await fixtureTabId();
          var state = await request(port, { type: 'REQUEST_STATE', tabId: tabId, expect: 'STATE' });
          var listenerText = (state.listeners || []).map(function (l) {
            return (l.listener || '') + ' ' + (l.stack || '');
          }).join(' ');
          var dedupeCount = (state.listeners || []).filter(function (l) {
            return (l.listener || '').indexOf('frxDedupeProbe') !== -1;
          }).length;
          return {
            listenerCount: (state.listeners || []).length,
            probeDetected: listenerText.indexOf('frxProbeListener') !== -1,
            dedupeCount: dedupeCount
          };
        });
"""


def run_panel_harness(driver, marker, source):
    result = driver.execute_async_script(source, marker)
    if result is None:
        return {"error": "harness returned no result (execute_async_script failed)"}
    if isinstance(result, str):
        return {"error": result[:500]}
    if not isinstance(result, dict):
        return {"error": "unexpected harness result type: %r" % result}
    return result


def main():
    ARTIFACTS.mkdir(parents=True, exist_ok=True)

    if not (DIST_FIREFOX / "manifest.json").is_file():
        fail("dist/firefox/manifest.json missing - run `npm run build` first")
        print("\nRESULT: FAIL\n%s" % "\n".join(FAILURES))
        sys.exit(1)

    firefox_bin = find_firefox_binary()
    geckodriver_path = find_geckodriver()
    log("firefox: %s" % firefox_bin)
    log("geckodriver: %s" % geckodriver_path)

    options = Options()
    options.binary_location = firefox_bin
    options.set_preference("xpinstall.signatures.required", False)
    options.set_preference("extensions.autoDisableScopes", 0)
    options.add_argument("-headless")

    service = webdriver.FirefoxService(executable_path=str(geckodriver_path))

    server = None
    driver = None
    try:
        addon_zip = make_addon_zip()
        log("add-on zip: %s" % addon_zip)

        driver = webdriver.Firefox(service=service, options=options)
        driver.set_script_timeout(30)
        driver.set_page_load_timeout(60)

        try:
            addon_id = driver.install_addon(str(addon_zip))
            log("install_addon returned: %r" % addon_id)
        except Exception as exc:  # noqa: BLE001
            hint = ""
            if "signed" in str(exc).lower():
                hint = (
                    " Release Firefox enforces add-on signing; use Firefox "
                    "Developer Edition or Nightly (set FIREFOX_BIN)."
                )
            fail("Failed to install add-on: %s.%s" % (exc, hint))
            raise

        server, port = serve(SCRIPT_DIR)
        fixture_url = "http://127.0.0.1:%d/fixture.html?marker=%s" % (port, MARKER)
        driver.get(fixture_url)

        state = fixture_ready(driver, fixture_url)
        if not state.get("loaded"):
            log("MAIN world flag missing on first load - reloading once")
            driver.refresh()
            state = fixture_ready(driver, fixture_url)
        check(
            bool(state.get("loaded")),
            "MAIN-world content script injected (window.FransceiverMainLoaded)",
        )
        check(
            state.get("posted", 0) >= 6,
            "fixture posted messages (%d)" % state.get("posted", 0),
        )

        time.sleep(2)

        fixture_handle = driver.current_window_handle
        driver.switch_to.new_window("tab")

        uuid = extension_uuid(driver)
        panel_url = "moz-extension://%s/panel.html" % uuid
        driver.get(panel_url)
        time.sleep(2)

        logo = poll(
            driver,
            "var el = document.querySelector('.logo'); return el ? el.textContent : '';",
            lambda value: bool(value),
            15,
            label="panel logo",
        )
        check(
            bool(logo) and "fransceiver" in str(logo).lower(),
            "panel UI rendered in extension page (logo: %r)" % logo,
        )

        driver.save_screenshot(str(ARTIFACTS / "panel.png"))

        # Phase 1: core pipeline.
        result = run_panel_harness(driver, MARKER, panel_harness(STATE_BODY))
        if result.get("error"):
            fail("panel harness error: %s" % result["error"])
        else:
            check(
                bool(result.get("extensionActive")),
                "service worker reports extensionActive",
            )
            check(
                result.get("listenerCount", 0) >= 1,
                "listeners captured for fixture tab (%d)" % result.get("listenerCount", 0),
            )
            check(
                bool(result.get("probeDetected")),
                "probe listener (frxProbeListener) captured with source/stack",
            )
            check(
                int(result.get("frameCount", 0)) >= 1,
                "frame tree populated (%d frames)" % result.get("frameCount", 0),
            )
            check(
                int(result.get("matchedMessages", 0)) >= 1,
                "posted messages captured end-to-end (%d matched)"
                % result.get("matchedMessages", 0),
            )
            check(
                bool(result.get("matchedHasTabId")),
                "captured messages attributed to the fixture tab",
            )

        # Phase 2: dedupe. Register the same listener twice from the page.
        driver.switch_to.window(fixture_handle)
        driver.execute_script(
            "window.__frxE2E && window.__frxE2E.registerDedupeProbe();"
        )
        time.sleep(1.5)
        driver.switch_to.window(
            [h for h in driver.window_handles if h != fixture_handle][0]
        )
        result = run_panel_harness(driver, MARKER, panel_harness(DEDUPE_BODY))
        if result.get("error"):
            fail("dedupe harness error: %s" % result["error"])
        else:
            check(
                int(result.get("probeCount", 0)) == 1,
                "original probe listener still present exactly once",
            )
            check(
                int(result.get("dedupeCount", 0)) == 1,
                "double-registered listener deduped to one (%d records)"
                % result.get("dedupeCount", 0),
            )

        # Phase 3: match & replace, end to end.
        # settings are broadcast because the SW watches storage.onChanged.
        mr_source = (
            "var done = arguments[arguments.length - 1];"
            "var marker = arguments[0];"
            "var rules = [{ pattern: 'secret-' + marker, replacement: 'REDACTED' }];"
            "chrome.storage.local.set({ matchReplaceRules: rules })"
            ".then(function () { done({ ok: true }); })"
            ".catch(function (e) { done({ error: String(e) }); });"
        )
        mr_result = run_panel_harness(driver, MARKER, mr_source)
        if not mr_result.get("ok"):
            fail("failed to persist match/replace rule: %s" % mr_result.get("error"))
        else:
            time.sleep(1.5)
            driver.switch_to.window(fixture_handle)
            driver.execute_script(
                "for (var i = 0; i < 3; i++) {"
                "  window.__frxE2E && window.__frxE2E.postSecret('secret-' + '%s');"
                "}" % MARKER
            )
            time.sleep(2)
            driver.switch_to.window(
                [h for h in driver.window_handles if h != fixture_handle][0]
            )
            result = run_panel_harness(driver, MARKER, panel_harness(SECRET_EVENTS_BODY))
            if result.get("error"):
                fail("match/replace harness error: %s" % result["error"])
            else:
                check(
                    int(result.get("spliced", 0)) >= 1,
                    "match/replace rewrote live payloads (%d spliced events)"
                    % result.get("spliced", 0),
                )
                check(
                    int(result.get("leaked", 0)) == 0,
                    "no captured event leaked the un-spliced secret",
                )

        # Phase 4: persistence across a background restart.
        reload_source = (
            "var done = arguments[arguments.length - 1];"
            "try { chrome.runtime.reload(); done({ ok: true }); }"
            "catch (e) { done({ error: String(e) }); }"
        )
        try:
            driver.execute_async_script(reload_source)
        except Exception as exc:  # noqa: BLE001
            log("runtime.reload teardown note: %r" % exc)
        time.sleep(4)

        # The extension reload discards the panel tab's browsing context (and
        # can close the tab). Recover by reopening the panel in a fresh tab.
        recovered = False
        for attempt in range(4):
            try:
                driver.get(panel_url)
                recovered = True
                break
            except Exception as exc:  # noqa: BLE001
                log("panel reopen attempt %d failed: %r" % (attempt + 1, exc))
                try:
                    handles = driver.window_handles
                    driver.switch_to.window(handles[-1])
                    driver.switch_to.new_window("tab")
                except Exception:  # noqa: BLE001
                    pass
                time.sleep(2)
        if recovered:
            time.sleep(1)
        else:
            fail("could not reopen the panel page after extension reload")
            raise RuntimeError("panel recovery failed")

        deadline = time.time() + 25
        persist = None
        while time.time() < deadline:
            persist = run_panel_harness(driver, MARKER, panel_harness(PERSIST_BODY))
            if persist.get("error"):
                time.sleep(1)
                continue
            if persist.get("listenerCount", 0) >= 2 and persist.get("probeDetected"):
                break
            time.sleep(1)

        if persist and not persist.get("error"):
            check(
                int(persist.get("listenerCount", 0)) >= 2,
                "listener state persisted across extension reload (%d records)"
                % persist.get("listenerCount", 0),
            )
            check(
                bool(persist.get("probeDetected")),
                "probe listener restored from storage after reload",
            )
            check(
                int(persist.get("dedupeCount", 0)) == 1,
                "dedupe identity stable after reload",
            )
        else:
            fail("persistence harness failed: %s" % (persist or {}))

        driver.switch_to.window(fixture_handle)
        driver.save_screenshot(str(ARTIFACTS / "fixture.png"))
    finally:
        if driver is not None:
            driver.quit()
        if server is not None:
            server.shutdown()

    if FAILURES:
        print("\nRESULT: FAIL (%d checks failed)" % len(FAILURES))
        for failure in FAILURES:
            print("  - %s" % failure)
        sys.exit(1)

    print("\nRESULT: PASS - Fransceiver Firefox e2e pipeline verified")
    sys.exit(0)


if __name__ == "__main__":
    main()