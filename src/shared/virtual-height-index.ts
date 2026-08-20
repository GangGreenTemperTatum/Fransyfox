/**
 * Fenwick-tree-backed row height index for virtual lists.
 *
 * Dataset replacements are O(n), while viewport lookups and measured-height
 * corrections are O(log n). This keeps scroll work independent of the number
 * of retained rows.
 */
export class VirtualHeightIndex {
  private heights: number[] = [];
  private tree: number[] = [0];

  get length(): number {
    return this.heights.length;
  }

  get totalHeight(): number {
    return this.prefixHeight(this.heights.length);
  }

  reset(heights: readonly number[]): void {
    this.heights = heights.map((height) => this.normalizeHeight(height));
    this.tree = new Array<number>(this.heights.length + 1).fill(0);

    // Linear Fenwick-tree construction. Each value contributes to its node,
    // which then contributes once to its parent.
    for (let index = 1; index <= this.heights.length; index += 1) {
      this.tree[index] += this.heights[index - 1];
      const parent = index + (index & -index);
      if (parent <= this.heights.length) {
        this.tree[parent] += this.tree[index];
      }
    }
  }

  update(index: number, height: number): boolean {
    if (!Number.isInteger(index) || index < 0 || index >= this.heights.length) {
      return false;
    }
    const nextHeight = this.normalizeHeight(height);
    const delta = nextHeight - this.heights[index];
    if (delta === 0) {
      return false;
    }
    this.heights[index] = nextHeight;
    for (let treeIndex = index + 1; treeIndex < this.tree.length; treeIndex += treeIndex & -treeIndex) {
      this.tree[treeIndex] += delta;
    }
    return true;
  }

  prefixHeight(endExclusive: number): number {
    let index = Math.max(0, Math.min(this.heights.length, Math.floor(endExclusive)));
    let sum = 0;
    while (index > 0) {
      sum += this.tree[index];
      index -= index & -index;
    }
    return sum;
  }

  /** Returns the row containing the offset, treating an exact row end as part of that row. */
  findRowAt(offset: number): number {
    if (this.heights.length === 0) {
      return 0;
    }
    const target = Math.max(0, Number.isFinite(offset) ? offset : 0);
    if (target <= 0) {
      return 0;
    }

    // Find the number of rows whose cumulative height is strictly below the
    // target. That count is also the zero-based row containing the target.
    let index = 0;
    let sum = 0;
    for (let step = this.highestPowerOfTwo(); step > 0; step >>= 1) {
      const next = index + step;
      if (next < this.tree.length && sum + this.tree[next] < target) {
        index = next;
        sum += this.tree[next];
      }
    }
    return Math.min(index, this.heights.length - 1);
  }

  /** Returns the exclusive row end needed to cover an offset. */
  findEndAfter(offset: number): number {
    if (this.heights.length === 0) {
      return 0;
    }
    const target = Math.max(0, Number.isFinite(offset) ? offset : 0);

    // Find how many row ends are at or before the target, then include the
    // following row because its top edge is still inside the viewport.
    let index = 0;
    let sum = 0;
    for (let step = this.highestPowerOfTwo(); step > 0; step >>= 1) {
      const next = index + step;
      if (next < this.tree.length && sum + this.tree[next] <= target) {
        index = next;
        sum += this.tree[next];
      }
    }
    return Math.min(this.heights.length, index + 1);
  }

  private normalizeHeight(height: number): number {
    return Number.isFinite(height) && height > 0 ? height : 0;
  }

  private highestPowerOfTwo(): number {
    let power = 1;
    while (power * 2 < this.tree.length) {
      power *= 2;
    }
    return power;
  }
}
