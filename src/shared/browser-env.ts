export type PanelSurfaceKind = 'sidePanel' | 'sidebarAction' | 'none';

interface FirefoxSidebarActionApi {
    open: () => Promise<void>;
    close: () => Promise<void>;
    toggle: () => Promise<void>;
    isOpen: () => Promise<boolean>;
}

interface FirefoxBrowserApi {
    sidebarAction?: FirefoxSidebarActionApi;
}

function getFirefoxBrowser(): FirefoxBrowserApi | null {
    const maybeBrowser = (globalThis as { browser?: FirefoxBrowserApi }).browser;
    return maybeBrowser && typeof maybeBrowser === 'object' ? maybeBrowser : null;
}

function getSidePanelApi(): typeof chrome.sidePanel | null {
    if (typeof chrome === 'undefined' || !('sidePanel' in chrome)) {
        return null;
    }
    return chrome.sidePanel;
}

export function getPanelSurfaceKind(): PanelSurfaceKind {
    if (getSidePanelApi()) {
        return 'sidePanel';
    }
    if (getFirefoxBrowser()?.sidebarAction) {
        return 'sidebarAction';
    }
    return 'none';
}

export function initializePanelSurface(): Promise<void> {
    const sidePanel = getSidePanelApi();
    if (!sidePanel) {
        return Promise.resolve();
    }
    return sidePanel
        .setOptions({ path: 'panel.html', enabled: false })
        .then(() => sidePanel.setPanelBehavior({ openPanelOnActionClick: false }));
}

export function configureTabPanelSurface(tabId: number, path: string): Promise<void> {
    const sidePanel = getSidePanelApi();
    if (!sidePanel) {
        return Promise.resolve();
    }
    return sidePanel.setOptions({ tabId, path, enabled: true });
}

export function configureTabPanelSurfaceWithCallback(
    tabId: number,
    path: string,
    callback: (error: unknown) => void
): void {
    const sidePanel = getSidePanelApi();
    if (!sidePanel) {
        callback(null);
        return;
    }
    sidePanel.setOptions({ tabId, path, enabled: true }, () => {
        const lastError = chrome.runtime.lastError;
        if (lastError) {
            callback(lastError.message || lastError);
            return;
        }
        callback(null);
    });
}

export function openPanelSurface(tabId: number): Promise<void> {
    const sidePanel = getSidePanelApi();
    if (sidePanel) {
        return sidePanel.open({ tabId });
    }
    const firefoxBrowser = getFirefoxBrowser();
    if (firefoxBrowser?.sidebarAction) {
        return firefoxBrowser.sidebarAction.open();
    }
    return Promise.reject(new Error('No panel surface available in this browser'));
}

export function closePanelSurface(tabId: number): Promise<void> {
    const sidePanel = getSidePanelApi();
    if (sidePanel) {
        if (typeof sidePanel.close === 'function') {
            return sidePanel.close({ tabId });
        }
        return sidePanel.setOptions({ tabId, enabled: false });
    }
    const firefoxBrowser = getFirefoxBrowser();
    if (firefoxBrowser?.sidebarAction) {
        return firefoxBrowser.sidebarAction.close();
    }
    return Promise.reject(new Error('No panel surface available in this browser'));
}

export async function toggleSidebarSurface(): Promise<boolean> {
    const firefoxBrowser = getFirefoxBrowser();
    if (!firefoxBrowser?.sidebarAction) {
        return false;
    }
    const isOpen = await firefoxBrowser.sidebarAction.isOpen();
    if (isOpen) {
        await firefoxBrowser.sidebarAction.close();
        return false;
    }
    await firefoxBrowser.sidebarAction.open();
    return true;
}

export function onPanelSurfaceOpened(listener: (tabId: number) => void): void {
    const sidePanel = getSidePanelApi();
    if (sidePanel && sidePanel.onOpened) {
        sidePanel.onOpened.addListener((info) => {
            if (typeof info.tabId === 'number') {
                listener(info.tabId);
            }
        });
    }
}

export function onPanelSurfaceClosed(listener: (tabId: number) => void): void {
    const sidePanel = getSidePanelApi();
    if (sidePanel && sidePanel.onClosed) {
        sidePanel.onClosed.addListener((info) => {
            if (typeof info.tabId === 'number') {
                listener(info.tabId);
            }
        });
    }
}