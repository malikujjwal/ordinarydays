import { describe, expect, it } from 'vitest';
import { listDetailScrollBottomPadding } from './ListDetailSurface';

describe('List detail rapid-entry keyboard clearance', () => {
  it('replaces the safe area with the live keyboard inset instead of accumulating offsets', () => {
    expect(listDetailScrollBottomPadding(0, 34, 16)).toBe(50);
    expect(listDetailScrollBottomPadding(336, 34, 16)).toBe(352);
    expect(listDetailScrollBottomPadding(280, 34, 16)).toBe(296);
    expect(listDetailScrollBottomPadding(0, 34, 16)).toBe(50);
  });

  it('returns the same inset across repeated rapid additions', () => {
    expect(
      Array.from({ length: 5 }, () => listDetailScrollBottomPadding(336, 34, 16)),
    ).toEqual([352, 352, 352, 352, 352]);
  });
});
