import { findNodeHandle, type ScrollView, UIManager, type View } from 'react-native';

/**
 * Scrolls a newly revealed Add-sheet section into view (native).
 *
 * Uses numeric node handles. `View.measureLayout(scroll.getScrollableNode())` throws
 * "ref.measureLayout must be called with a ref to a native component" because that API
 * wants a host instance, not a handle.
 */
export function scrollRevealedSectionIntoView(
  scroll: ScrollView | null,
  child: View | null,
): void {
  if (scroll === null || child === null) return;

  const childNode = findNodeHandle(child);
  const inner = (
    scroll as ScrollView & { getInnerViewNode?: () => number | null }
  ).getInnerViewNode?.();
  const relativeNode = inner ?? findNodeHandle(scroll);
  if (childNode == null || relativeNode == null) return;

  UIManager.measureLayout(
    childNode,
    relativeNode,
    () => {},
    (_x, y) => {
      scroll.scrollTo({ y: Math.max(0, y), animated: true });
    },
  );
}
