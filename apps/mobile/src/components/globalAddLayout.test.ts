import { space } from '@od/ui';
import { describe, expect, it } from 'vitest';
import {
  bottomChromeScrollPadding,
  GLOBAL_ADD_SCROLL_PADDING,
  TAB_BAR_HEIGHT,
  tabBarBottomOffset,
} from './globalAddLayout';

/** A notched iPhone's home-indicator inset; web and a home-button device both report 0. */
const HOME_INDICATOR_INSET = 34;

describe('tabBarBottomOffset', () => {
  it('leaves the browser value alone', () => {
    expect(tabBarBottomOffset(0)).toBe(space[2]);
  });

  /**
   * The founder's 2026-08-18 report. Adding the inset put the same capsule 38 pt up on an
   * iPhone and 4 pt up on web; the cap is what stops one component reading as two designs.
   */
  it('caps the home-indicator inset instead of adding it', () => {
    expect(tabBarBottomOffset(HOME_INDICATOR_INSET)).toBe(space[4]);
    expect(tabBarBottomOffset(HOME_INDICATOR_INSET)).toBeLessThan(
      HOME_INDICATOR_INSET + space[2],
    );
  });

  it('still clears the indicator glyph rather than sitting on the screen edge', () => {
    expect(tabBarBottomOffset(HOME_INDICATOR_INSET)).toBeGreaterThan(space[3]);
  });

  it('never shrinks as the inset grows', () => {
    const offsets = [0, 8, 20, 34, 50].map(tabBarBottomOffset);
    expect(offsets).toStrictEqual([...offsets].sort((a, b) => a - b));
  });
});

describe('bottomChromeScrollPadding', () => {
  /**
   * The reservation and the bar's own position are one number, not two. They were written
   * separately once and drifted 4 pt apart, which is how a last row ends up under the capsule.
   */
  it.each([0, HOME_INDICATOR_INSET])(
    'reserves exactly the bar plus the gap it floats by (inset %i)',
    (inset) => {
      expect(bottomChromeScrollPadding(inset)).toBe(
        GLOBAL_ADD_SCROLL_PADDING + TAB_BAR_HEIGHT + tabBarBottomOffset(inset),
      );
    },
  );

  it('always clears the bar itself', () => {
    for (const inset of [0, 20, HOME_INDICATOR_INSET]) {
      expect(bottomChromeScrollPadding(inset)).toBeGreaterThan(
        TAB_BAR_HEIGHT + tabBarBottomOffset(inset),
      );
    }
  });
});
