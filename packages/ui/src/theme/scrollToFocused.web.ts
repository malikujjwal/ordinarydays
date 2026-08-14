import type { RefObject } from 'react';
import type { ScrollView } from 'react-native';

/**
 * The web fork of `useScrollToFocusedInput` — deliberately a no-op.
 *
 * Browsers scroll a focused element into view themselves, and have done since long before this
 * app existed. Running our own measure-and-scroll on top would fight the browser's: two
 * corrections for one problem, arriving a frame apart, which reads as a jump.
 *
 * Kept as a fork rather than a `Platform.OS` branch inside the native file so the web bundle
 * carries none of `TextInput.State` or the measurement code, and so the reason is written where
 * somebody wondering "why does this do nothing on web" will find it.
 */
export function useScrollToFocusedInput(
  _scrollRef: RefObject<ScrollView | null>,
  _keyboardInset: number,
  _viewportHeight: number,
): void {
  // Intentionally empty; see above.
}
