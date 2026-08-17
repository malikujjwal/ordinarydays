import { space } from '@od/ui';

/** The global Add control's 56 × 56 pt visual size (`interaction-contract.md` §2). */
export const GLOBAL_ADD_SIZE = 56;

/**
 * The bottom tab bar's own height, before the safe-area inset.
 *
 * Stated here rather than only in `app/(app)/(tabs)/_layout.tsx` because two things need it and
 * they must not disagree: the bar draws itself this tall, and every scrolling tab has to reserve
 * it. `space[11]` is 64 — enough for a 28 pt icon slot above an 18 pt label line, which the
 * navigator's 48 pt web default is not.
 */
export const TAB_BAR_HEIGHT = space[11];

/**
 * Scrollable tabs reserve this space after their final row so it can move above the floating
 * control. This belongs to scroll content, never the viewport around it.
 */
export const GLOBAL_ADD_SCROLL_PADDING = space[5] + GLOBAL_ADD_SIZE + space[3];

/**
 * The gap between the floating tab bar's bottom edge and the bottom of the screen.
 *
 * **The home-indicator inset is capped here, not added on top** — amended 2026-08-18 on the
 * founder's report that the capsule "is above a certain height" on an iPhone while looking
 * right on web. A phone with a home indicator reports `insets.bottom` of 34 pt and web reports
 * 0, so adding the inset to a fixed gap floated the same component 38 pt up on device and 4 pt
 * up in a browser — one capsule reading as two different designs. Capping keeps the web value
 * exactly where it is and brings the device down to a gap that still clears the indicator glyph.
 *
 * This is the **only** statement of that offset. It used to be written twice — as
 * `insets.bottom + space[2]` where the bar is drawn and `insetBottom + space[3]` where scrolling
 * content reserves room for it — two copies of one position, already disagreeing by 4 pt.
 */
export const tabBarBottomOffset = (insetBottom: number): number =>
  Math.min(insetBottom + space[2], space[4]);

/**
 * The room a scrolling tab must leave beneath its last row — added 2026-08-17.
 *
 * **The tab bar overlays the scroll view; it does not sit below it.** On web React Navigation
 * renders each tab as an anchor in a bar painted over the content, so a row that comes to rest
 * under it is visible and *not clickable* — `document.elementFromPoint` at the row's own centre
 * returns the tab's `<a>`. The founder's report was that rows behind the tabs do not respond,
 * and this is why: nothing was broken about the row, it was simply underneath something.
 *
 * Reserving the bar's height plus the gap it floats by means the last row can always be scrolled
 * clear of both it and the floating Add control. The inset is a runtime value, so this is a
 * function rather than a constant.
 */
export const bottomChromeScrollPadding = (insetBottom: number): number =>
  GLOBAL_ADD_SCROLL_PADDING + TAB_BAR_HEIGHT + tabBarBottomOffset(insetBottom);
