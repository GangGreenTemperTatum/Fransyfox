import { describe, expect, it } from 'vitest';
import { VirtualHeightIndex } from './virtual-height-index';

describe('VirtualHeightIndex', () => {
  it('finds viewport boundaries without scanning the row list', () => {
    const index = new VirtualHeightIndex();
    index.reset([10, 20, 30, 40]);

    expect(index.totalHeight).toBe(100);
    expect(index.findRowAt(0)).toBe(0);
    expect(index.findRowAt(10)).toBe(0);
    expect(index.findRowAt(11)).toBe(1);
    expect(index.findRowAt(31)).toBe(2);
    expect(index.findRowAt(1000)).toBe(3);

    expect(index.findEndAfter(0)).toBe(1);
    expect(index.findEndAfter(10)).toBe(2);
    expect(index.findEndAfter(29)).toBe(2);
    expect(index.findEndAfter(30)).toBe(3);
    expect(index.findEndAfter(1000)).toBe(4);
  });

  it('updates cumulative heights after a row is measured', () => {
    const index = new VirtualHeightIndex();
    index.reset([10, 10, 10]);

    expect(index.update(1, 25)).toBe(true);
    expect(index.update(1, 25)).toBe(false);
    expect(index.prefixHeight(2)).toBe(35);
    expect(index.totalHeight).toBe(45);
    expect(index.findRowAt(20)).toBe(1);
    expect(index.findEndAfter(35)).toBe(3);
  });

  it('handles empty indexes and invalid measurements safely', () => {
    const index = new VirtualHeightIndex();
    index.reset([]);

    expect(index.totalHeight).toBe(0);
    expect(index.findRowAt(50)).toBe(0);
    expect(index.findEndAfter(50)).toBe(0);
    expect(index.update(0, 10)).toBe(false);

    index.reset([Number.NaN, -4, 12]);
    expect(index.totalHeight).toBe(12);
  });
});
