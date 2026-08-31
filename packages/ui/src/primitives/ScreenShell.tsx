import { type ReactNode, useEffect, useRef, useState } from 'react';
import {
  type ScrollView as RNScrollView,
  ScrollView,
  type ScrollViewProps,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  useBreakpoint,
  useKeyboardInset,
  useScrollToFocusedInput,
  useTheme,
} from '../theme/index';

export interface ScreenShellProps {
  children: ReactNode;
  /**
   * Fixed chrome above the scrolling body — a title, a back row. It sits inside the same
   * column and gutters, so it lines up with the body rather than being aligned by eye.
   */
  header?: ReactNode;
  /**
   * Fixed chrome **below** the scrolling body — a form's named write action.
   *
   * Added 2026-08-16 (P2-43), and here for the reason §6.1 gives the sheet's `actions` slot: a
   * screen supplies the control and does not decide where it sits, how clear of the home
   * indicator it is, or what happens to it when the keyboard opens. Left to each screen, the
   * one control an edit cannot finish without is the one that ends up behind the keyboard.
   */
  footer?: ReactNode;
  /** A screen whose body is its own virtualised list scrolls itself; pass `false`. */
  scroll?: boolean;
  /**
   * `standard` is `design-system.md` §8's 720 pt column. `reading` narrows to 620 for a screen
   * that is mostly running text — the measure at which a line stops being tiring to read. It is
   * a deliberate choice per screen, not a per-screen invention: those are the only two.
   */
  measure?: 'standard' | 'reading';
  /** Tight bridge from a standard header to immediately useful content (§7.2b). */
  bodySpacing?: 'standard' | 'compact';
  /** Pagination/analytics for the ScrollView this container owns. */
  onScroll?: ScrollViewProps['onScroll'];
  scrollEventThrottle?: number;
  /**
   * Keeps a final inline editor wholly above the software keyboard.
   *
   * The focused input alone can be visible while controls below it are still occluded. This
   * remains a container concern: the screen declares that its final child is one editor, and
   * the owned ScrollView performs the keyboard/content-size correction without screen-level
   * offsets.
   */
  keepEndVisibleWithKeyboard?: boolean;
  testID?: string;
}

const MEASURE = { standard: 720, reading: 620 } as const;

/**
 * The frame every screen sits in (`design-system.md` §8).
 *
 * It owns the four things every screen was answering for itself, all of which drifted:
 *
 * - **Gutters.** `space[5]` at `compact`, `space[7]` from `medium` up.
 * - **The column.** Full width at `compact`; capped and centred above it.
 * - **The safe area.** Top inset under the notch, bottom inset clear of the home indicator.
 * - **Vertical breathing room** above the first element and below the last.
 *
 * Fifteen files set their own vertical screen padding before this existed, and the two screens
 * that both capped their column disagreed about the number — 720 on the tabs, 620 on activity
 * detail, neither aware of the other. "The screen needs more padding" was consequently a
 * fifteen-file edit that nobody could complete, which is the whole reason this component is
 * here: **it is the one place that answers, so changing the answer is one edit.**
 */
export function ScreenShell({
  children,
  header,
  footer,
  scroll = true,
  measure = 'standard',
  bodySpacing = 'standard',
  onScroll,
  scrollEventThrottle,
  keepEndVisibleWithKeyboard = false,
  testID,
}: ScreenShellProps) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const compact = useBreakpoint() === 'compact';
  const keyboard = useKeyboardInset();
  const scrollRef = useRef<RNScrollView | null>(null);
  const [contentHeight, setContentHeight] = useState(0);
  /**
   * `useWindowDimensions`, never `Dimensions.get()` at module scope (§21): the viewport changes
   * on rotation, on a browser resize, and when the keyboard itself shrinks it.
   */
  const { height: viewportHeight } = useWindowDimensions();
  useScrollToFocusedInput(scrollRef, keyboard, viewportHeight, contentHeight);
  useEffect(() => {
    // A rapid add changes only content size while the keyboard and editor remain mounted.
    void contentHeight;
    if (!keepEndVisibleWithKeyboard || keyboard <= 0) return;
    const frame = requestAnimationFrame(() => {
      scrollRef.current?.scrollToEnd({ animated: false });
    });
    return () => cancelAnimationFrame(frame);
  }, [contentHeight, keepEndVisibleWithKeyboard, keyboard]);

  const column = {
    width: '100%',
    alignSelf: 'center',
    ...(compact ? {} : { maxWidth: MEASURE[measure] }),
    paddingHorizontal: compact ? theme.space[5] : theme.space[7],
  } as const;

  const body = <View style={column}>{children}</View>;

  return (
    <View
      style={{
        flex: 1,
        backgroundColor: theme.colors.surface,
        /**
         * **The footer rides above the keyboard, not behind it** (§6.2). Insetting the frame is
         * what lifts it, and it lifts the body with it; the scroll's own keyboard padding is
         * dropped below in the same branch so the room is not paid for twice.
         */
        ...(footer === undefined ? {} : { paddingBottom: keyboard }),
      }}
      testID={testID}
    >
      {header === undefined ? null : (
        <View style={[column, { paddingTop: insets.top + theme.space[5] }]}>
          {header}
        </View>
      )}

      {scroll ? (
        <ScrollView
          ref={scrollRef}
          onScroll={onScroll}
          scrollEventThrottle={scrollEventThrottle}
          onContentSizeChange={(_width, height) => setContentHeight(height)}
          automaticallyAdjustKeyboardInsets
          keyboardDismissMode="interactive"
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{
            paddingTop:
              header === undefined
                ? insets.top + theme.space[7]
                : bodySpacing === 'compact'
                  ? theme.space[3]
                  : theme.space[6],
            /**
             * **Enough room to scroll a field out from under the keyboard** (§20). Without the
             * inset the last field on a long screen cannot be brought into view at all — there
             * is nothing below it to scroll. The safe-area inset drops out while the keyboard
             * covers the home indicator.
             */
            paddingBottom:
              footer === undefined
                ? (keyboard > 0 ? keyboard : insets.bottom) + theme.space[8]
                : theme.space[8],
          }}
          testID={testID === undefined ? undefined : `${testID}-body`}
        >
          {body}
        </ScrollView>
      ) : (
        <View
          style={{
            flex: 1,
            paddingTop: bodySpacing === 'compact' ? theme.space[3] : theme.space[6],
          }}
          testID={testID === undefined ? undefined : `${testID}-body`}
        >
          {body}
        </View>
      )}

      {footer === undefined ? null : (
        <View
          style={{
            borderTopWidth: 1,
            borderTopColor: theme.colors.border,
            backgroundColor: theme.colors.surface,
            paddingTop: theme.space[5],
            // The home indicator is irrelevant while the keyboard covers it (§6.2).
            paddingBottom: theme.space[5] + (keyboard > 0 ? 0 : insets.bottom),
          }}
          testID={testID === undefined ? undefined : `${testID}-footer`}
        >
          <View style={column}>{footer}</View>
        </View>
      )}
    </View>
  );
}
