import { space } from '@od/ui';

/** The global Add control's 56 × 56 pt visual size (`interaction-contract.md` §2). */
export const GLOBAL_ADD_SIZE = 56;

/**
 * Scrollable tabs reserve this space after their final row so it can move above the floating
 * control. This belongs to scroll content, never the viewport around it.
 */
export const GLOBAL_ADD_SCROLL_PADDING = space[5] + GLOBAL_ADD_SIZE + space[3];
