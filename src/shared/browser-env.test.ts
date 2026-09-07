import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  closePanelSurface,
  configureTabPanelSurfaceWithCallback,
  getPanelSurfaceKind,
  initializePanelSurface,
  onPanelSurfaceClosed,
  onPanelSurfaceOpened,
  openPanelSurface,
  toggleSidebarSurface
} from './browser-env';

afterEach(() => {
  vi.unstubAllGlobals();
});

interface SidePanelApiStub {
  open: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn> | undefined;
  setOptions: ReturnType<typeof vi.fn>;
  setPanelBehavior: ReturnType<typeof vi.fn>;
  onOpened: { addListener: ReturnType<typeof vi.fn> };
  onClosed: { addListener: ReturnType<typeof vi.fn> };
}

interface SidebarActionApiStub {
  open: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  toggle: ReturnType<typeof vi.fn>;
  isOpen: ReturnType<typeof vi.fn>;
}

function stubSidePanel(overrides: Record<string, unknown> = {}): SidePanelApiStub {
  const api = {
    open: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    setOptions: vi.fn().mockResolvedValue(undefined),
    setPanelBehavior: vi.fn().mockResolvedValue(undefined),
    onOpened: { addListener: vi.fn() },
    onClosed: { addListener: vi.fn() },
    ...overrides
  };
  vi.stubGlobal('chrome', {
    sidePanel: api,
    runtime: { lastError: null }
  });
  return api;
}

function stubSidebarAction(overrides: Record<string, unknown> = {}): SidebarActionApiStub {
  const api = {
    open: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    toggle: vi.fn().mockResolvedValue(undefined),
    isOpen: vi.fn().mockResolvedValue(false),
    ...overrides
  };
  vi.stubGlobal('browser', { sidebarAction: api });
  return api;
}

describe('getPanelSurfaceKind', () => {
  test('detects chrome.sidePanel', () => {
    stubSidePanel();
    expect(getPanelSurfaceKind()).toBe('sidePanel');
  });

  test('detects browser.sidebarAction on Firefox', () => {
    stubSidebarAction();
    expect(getPanelSurfaceKind()).toBe('sidebarAction');
  });

  test('reports none when no surface exists', () => {
    expect(getPanelSurfaceKind()).toBe('none');
  });
});

describe('panel surface operations', () => {
  test('Chrome open() delegates to chrome.sidePanel.open per tab', async () => {
    const api = stubSidePanel();
    await openPanelSurface(7);
    expect(api.open).toHaveBeenCalledWith({ tabId: 7 });
  });

  test('Firefox open() delegates to sidebarAction.open', async () => {
    const api = stubSidebarAction();
    await openPanelSurface(7);
    expect(api.open).toHaveBeenCalled();
  });

  test('Chrome close() falls back to setOptions disabled when close() is missing', async () => {
    const api = stubSidePanel({ close: undefined });
    await closePanelSurface(7);
    expect(api.setOptions).toHaveBeenCalledWith({ tabId: 7, enabled: false });
  });

  test('Firefox close() delegates to sidebarAction.close', async () => {
    const api = stubSidebarAction();
    await closePanelSurface(7);
    expect(api.close).toHaveBeenCalled();
  });

  test('toggleSidebarSurface opens when closed and reports new state', async () => {
    const api = stubSidebarAction({ isOpen: vi.fn().mockResolvedValue(false) });
    await expect(toggleSidebarSurface()).resolves.toBe(true);
    expect(api.open).toHaveBeenCalled();
  });

  test('toggleSidebarSurface does nothing without Firefox sidebar', async () => {
    await expect(toggleSidebarSurface()).resolves.toBe(false);
  });

  test('initializePanelSurface disables global side panel on Chrome', async () => {
    const api = stubSidePanel();
    await initializePanelSurface();
    expect(api.setOptions).toHaveBeenCalledWith({ path: 'panel.html', enabled: false });
    expect(api.setPanelBehavior).toHaveBeenCalledWith({ openPanelOnActionClick: false });
  });

  test('configureTabPanelSurfaceWithCallback calls callback immediately without a surface', () => {
    const callback = vi.fn();
    configureTabPanelSurfaceWithCallback(3, 'panel.html', callback);
    expect(callback).toHaveBeenCalledWith(null);
  });

  test('Chrome open/close events relay tab ids', () => {
    const api = stubSidePanel();
    const opened = vi.fn();
    const closed = vi.fn();
    onPanelSurfaceOpened(opened);
    onPanelSurfaceClosed(closed);
    type TabInfoListener = (info: { tabId: number }) => void;
    const openedListener = api.onOpened.addListener.mock.calls[0][0] as TabInfoListener;
    const closedListener = api.onClosed.addListener.mock.calls[0][0] as TabInfoListener;
    openedListener({ tabId: 11 });
    closedListener({ tabId: 12 });
    expect(opened).toHaveBeenCalledWith(11);
    expect(closed).toHaveBeenCalledWith(12);
  });
});