/**
 * Retains snapshots only for live known tabs. A late update from a removed tab
 * cannot recreate its entry, while known inactive tabs keep their fast path.
 */
export class TabSnapshotCache<T> {
  private readonly snapshots = new Map<number, T>();

  get(tabId: number): T | undefined {
    return this.snapshots.get(tabId);
  }

  set(tabId: number, snapshot: T): void {
    this.snapshots.set(tabId, snapshot);
  }

  setIfKnownOrCurrent(tabId: number, currentTabId: number | null, snapshot: T): boolean {
    if (tabId !== currentTabId && !this.snapshots.has(tabId)) return false;
    this.snapshots.set(tabId, snapshot);
    return true;
  }

  remove(tabId: number): void {
    this.snapshots.delete(tabId);
  }

  clear(): void {
    this.snapshots.clear();
  }
}
