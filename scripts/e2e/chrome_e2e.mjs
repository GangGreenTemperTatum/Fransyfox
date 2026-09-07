#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { access, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import puppeteer from 'puppeteer-core';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(dirname(SCRIPT_DIR));
const DIST_CHROME = join(ROOT, 'dist', 'chrome');
const FIXTURE = join(SCRIPT_DIR, 'fixture.html');
const MARKER = `frx-chrome-${Date.now()}`;

function chromeBinary() {
  if (process.env.CHROME_BIN) return process.env.CHROME_BIN;
  if (process.platform === 'darwin') return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  return 'google-chrome';
}

async function startFixtureServer() {
  const fixture = await readFile(FIXTURE);
  const server = createServer((request, response) => {
    if (request.url?.startsWith('/fixture.html')) {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(fixture);
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert(address && typeof address === 'object', 'fixture server did not bind');
  return { server, url: `http://127.0.0.1:${address.port}/fixture.html?marker=${MARKER}` };
}

async function readCaptureState(page) {
  return page.evaluate(async (marker) => {
    const tabs = await chrome.tabs.query({});
    const fixture = tabs.find((tab) => typeof tab.url === 'string' && tab.url.includes('/fixture.html'));
    if (!fixture?.id) throw new Error('fixture tab not found');

    const port = chrome.runtime.connect({ name: 'chrome-e2e-harness' });
    const request = (payload) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for ${payload.expect}`)), 15_000);
      const listener = (message) => {
        if (message?.type === payload.expect &&
            !(typeof payload.tabId === 'number' && message.tabId !== payload.tabId)) {
          clearTimeout(timer);
          port.onMessage.removeListener(listener);
          resolve(message);
        }
      };
      port.onMessage.addListener(listener);
      port.postMessage(payload);
    });

    try {
      const state = await request({ type: 'REQUEST_STATE', tabId: fixture.id, expect: 'STATE' });
      const events = await request({ type: 'REQUEST_EVENTS', expect: 'EVENTS' });
      const listenerText = (state.listeners || []).map((listener) => `${listener.listener || ''} ${listener.stack || ''}`).join(' ');
      const matchingEvents = (events.events || []).filter((event) => (event.dataText || '').includes(marker));
      return {
        active: state.extensionActive,
        listenerCount: (state.listeners || []).length,
        probeDetected: listenerText.includes('frxProbeListener'),
        matchingEvents: matchingEvents.length,
        tabAttributed: matchingEvents.some((event) => event.tabId === fixture.id)
      };
    } finally {
      port.disconnect();
    }
  }, MARKER);
}

let browser;
let fixtureServer;
try {
  await access(join(DIST_CHROME, 'manifest.json'), constants.R_OK);
  const fixture = await startFixtureServer();
  fixtureServer = fixture.server;
  browser = await puppeteer.launch({
    executablePath: chromeBinary(),
    headless: true,
    enableExtensions: [DIST_CHROME],
    args: [
      '--no-first-run',
      '--no-default-browser-check'
    ]
  });

  const worker = await browser.waitForTarget(
    (target) => target.type() === 'service_worker' && target.url().startsWith('chrome-extension://'),
    { timeout: 15_000 }
  );
  const workerClient = await worker.worker();
  assert(workerClient, 'extension service worker is unavailable');
  await workerClient.evaluate(async () => {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const scripts = await chrome.scripting.getRegisteredContentScripts();
      const ids = new Set(scripts.map((script) => script.id));
      if (ids.has('fransyfox-main-world') && ids.has('fransyfox-bridge-world')) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('Fransyfox dynamic content scripts were not registered');
  });

  const fixturePage = await browser.newPage();
  await fixturePage.goto(fixture.url, { waitUntil: 'load' });
  await fixturePage.waitForFunction(
    () => globalThis.FransyfoxMainLoaded === true && globalThis.__frxE2E?.messagesPosted >= 6,
    { timeout: 15_000 }
  );

  await workerClient.evaluate(async () => {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const tabs = await chrome.tabs.query({});
      const fixture = tabs.find((tab) => tab.url?.includes('/fixture.html'));
      if (typeof fixture?.id === 'number') {
        const options = await chrome.sidePanel.getOptions({ tabId: fixture.id });
        if (options.enabled === true && options.path === 'panel.html') return;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('fixture tab side panel was not configured');
  });
  const panelPage = await browser.newPage();
  await panelPage.goto(new URL('panel.html', worker.url()).href, { waitUntil: 'domcontentloaded' });
  await panelPage.waitForSelector('.logo', { timeout: 15_000 });
  assert.match(await panelPage.$eval('.logo', (element) => element.textContent ?? ''), /fransyfox/i, 'panel UI did not render');

  const capture = await readCaptureState(panelPage);
  assert.equal(capture.active, true, 'service worker is inactive');
  assert.ok(capture.listenerCount >= 1, `expected captured listener, got ${capture.listenerCount}`);
  assert.equal(capture.probeDetected, true, 'fixture listener was not captured');
  assert.ok(capture.matchingEvents >= 1, `expected captured messages, got ${capture.matchingEvents}`);
  assert.equal(capture.tabAttributed, true, 'captured message lacks fixture tab attribution');

  console.log('RESULT: PASS - Fransyfox Chrome E2E pipeline verified');
} finally {
  await browser?.close();
  await new Promise((resolve) => fixtureServer?.close(resolve) ?? resolve());
}
