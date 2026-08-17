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
 * The room a scrolling tab must leave beneath its last row — added 2026-08-17.
 *
 * **The tab bar overlays the scroll view; it does not sit below it.** On web React Navigation
 * renders each tab as an anchor in a bar painted over the content, so a row that comes to rest
 * under it is visible and *not clickable* — `document.elementFromPoint` at the row's own centre
 * returns the tab's `<a>`. The founder's report was that rows behind the tabs do not respond,
 * and this is why: nothing was broken about the row, it was simply underneath something.
 *
 * Reserving the bar's height plus the safe-area inset means the last row can always be scrolled
 * clear of both it and the floating Add control. The inset is a runtime value, so this is a
 * function rather than a constant.
 */
export const bottomChromeScrollPadding = (insetBottom: number): number =>
  // The bar floats since 2026-08-17, so its own bottom margin is reserved alongside its height.
  GLOBAL_ADD_SCROLL_PADDING + TAB_BAR_HEIGHT + insetBottom + space[3];
