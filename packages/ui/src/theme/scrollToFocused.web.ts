import { type RefObject, useEffect } from 'react';
import type { ScrollView } from 'react-native';

const FOCUSED_CONTEXT_CLEARANCE = 32;

function nearestScrollOwner(element: HTMLElement): HTMLElement | undefined {
  let parent = element.parentElement;
  while (parent !== null) {
    const overflowY = window.getComputedStyle(parent).overflowY;
    if (
      (overflowY === 'auto' || overflowY === 'scroll') &&
      parent.scrollHeight > parent.clientHeight
    ) {
      return parent;
    }
    parent = parent.parentElement;
  }
  return undefined;
}

/**
 * The web fork of `useScrollToFocusedInput`.
 *
 * Browsers scroll a field when it first receives focus. They do not repeat that correction when
 * rapid entry inserts content above an already-focused field, so the nearest-scroll correction
 * runs only while a software-keyboard inset exists and the field is actually occluded. DOM
 * `scrollIntoView` uses the layout viewport, which still extends behind a mobile keyboard, so
 * this fork applies the visual-viewport occlusion delta to the nearest scroll owner directly.
 *
 * Kept as a fork so the web bundle uses DOM focus and `visualViewport`, while native keeps
 * `TextInput.State` and the ScrollView node measurement.
 */
export function useScrollToFocusedInput(
  _scrollRef: RefObject<ScrollView | null>,
  keyboardInset: number,
  viewportHeight: number,
  contentHeight = 0,
): void {
  useEffect(() => {
    // Reading the measured size makes insertion itself a remeasurement trigger while the same
    // input retains focus; the value is not part of the offset calculation.
    void contentHeight;
    if (keyboardInset <= 0) return;
    let frame: number | undefined;
    const correctFocusedInput = () => {
      const focused = document.activeElement;
      if (
        !(focused instanceof HTMLInputElement || focused instanceof HTMLTextAreaElement)
      ) {
        return;
      }
      const viewport = window.visualViewport;
      const visibleBottom =
        viewport === null
          ? viewportHeight - keyboardInset
          : viewport.offsetTop + viewport.height;
      const occludedBy =
        focused.getBoundingClientRect().bottom -
        (visibleBottom - FOCUSED_CONTEXT_CLEARANCE);
      if (occludedBy <= 0) return;

      const scrollOwner = nearestScrollOwner(focused);
      if (scrollOwner === undefined) {
        window.scrollBy({ top: occludedBy, behavior: 'auto' });
        return;
      }
      scrollOwner.scrollTop += occludedBy;
    };

    const scheduleCorrection = () => {
      if (frame !== undefined) window.cancelAnimationFrame(frame);
      // React Native Web applies `autoFocus` and the browser's layout-viewport correction during
      // the first frame. Correct against the visual viewport in the following frame so that
      // browser scroll cannot overwrite the keyboard-aware position.
      frame = window.requestAnimationFrame(() => {
        frame = window.requestAnimationFrame(correctFocusedInput);
      });
    };

    scheduleCorrection();
    document.addEventListener('focusin', scheduleCorrection);

    return () => {
      if (frame !== undefined) window.cancelAnimationFrame(frame);
      document.removeEventListener('focusin', scheduleCorrection);
    };
  }, [contentHeight, keyboardInset, viewportHeight]);
}
