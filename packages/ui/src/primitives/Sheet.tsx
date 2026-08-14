import { useCallback, useMemo, useRef } from 'react';
import {
  Animated,
  Modal,
  PanResponder,
  Platform,
  Pressable,
  type ScrollView as RNScrollView,
  ScrollView,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Close } from '../icons/index';
import {
  useBreakpoint,
  useKeyboardInset,
  useMotion,
  useScrollToFocusedInput,
  useTheme,
} from '../theme/index';
import { IconButton } from './IconButton';
import { Text } from './Text';

/**
 * A modal surface, and the behaviour that goes with it (`design-system.md` §6.1, §6.2).
 *
 * **Bottom sheet at `compact`, centred dialog at `medium` and above** — a pointer does not make
 * a drag gesture, so the centred form has neither a grabber nor a drag.
 *
 * ## Why this owns so much
 *
 * The primitive used to own only the surface, and every modal decided its own height, its own
 * scrolling and its own footer. That is how `Repeat` — three controls — came to occupy almost a
 * whole phone: it set `maxHeight: 620` on its own body, which §0's ownership rule now forbids in
 * as many words. **A screen supplies content and actions; it does not decide geometry.**
 */
export interface SheetProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: React.ReactNode;
  /**
   * §6.1's detent table, keyed to the task rather than to taste.
   *
   * - `fit` — a short control (Repeat, Snooze, a simple picker). The sheet ends shortly after
   *   its content instead of running to the bottom of the device because the room is there.
   * - `medium` — a choice list (reminder offsets, people, lists), scrolling internally.
   * - `large` — an editor or keyboard-heavy form.
   *
   * A flow long enough to need more than `large` is a screen. Navigate to it rather than
   * disguising it as a tall modal.
   */
  detent?: 'fit' | 'medium' | 'large';
  /**
   * The fixed footer. **The screen supplies the buttons; this decides where they sit** — left to
   * each modal, `Done`, `Cancel` and `Apply` acquired a different arrangement every time, and
   * one of them stacked into a column because the content above it happened to grow.
   */
  actions?: React.ReactNode;
  dismissible?: boolean;
  /**
   * The sheet holds unsaved changes, so **every** dismissal path asks first.
   *
   * §20: `✕` asking while swipe silently discards is the divergence this exists to prevent.
   * Scrim, close button, hardware Back, Escape and the drag all converge on one `requestClose`,
   * so a screen cannot accidentally guard one and forget another.
   */
  dirty?: boolean;
  /** Called in place of `onClose` while `dirty`. The screen owns the prompt it shows. */
  onDiscardRequest?: () => void;
  testID?: string;
}

/** Past this, releasing dismisses. Below it the sheet springs back. */
const DISMISS_DISTANCE = 96;
/** A fast flick dismisses even from a short distance — px per ms. */
const DISMISS_VELOCITY = 0.6;

export function Sheet({
  open,
  onClose,
  title,
  children,
  detent = 'fit',
  actions,
  dismissible = true,
  dirty = false,
  onDiscardRequest,
  testID,
}: SheetProps) {
  const theme = useTheme();
  const breakpoint = useBreakpoint();
  const insets = useSafeAreaInsets();
  const keyboard = useKeyboardInset();
  const motion = useMotion();
  const bodyRef = useRef<RNScrollView | null>(null);
  const { height: viewportHeight } = useWindowDimensions();
  useScrollToFocusedInput(bodyRef, keyboard, viewportHeight);
  const centred = breakpoint !== 'compact';

  /** Only a bottom sheet drags, and only when it is allowed to close at all. */
  const draggable = !centred && dismissible;

  const translateY = useRef(new Animated.Value(0)).current;
  /**
   * Whether the body is scrolled to its top. **This is what stops the gesture being ambiguous**
   * (§25): mid-scroll, a downward drag scrolls the content; at the top, it dismisses. Without
   * it a pull-down inside a long choice list would fight the list.
   */
  const bodyAtTop = useRef(true);

  const requestClose = useCallback(() => {
    if (dirty && onDiscardRequest !== undefined) {
      onDiscardRequest();
      return;
    }
    onClose();
  }, [dirty, onDiscardRequest, onClose]);

  /**
   * Back to rest. **Reduce Motion gets no spring** — `interaction-contract.md` §6 keeps direct
   * manipulation (the drag itself) but removes the decorative rebound, so the sheet simply
   * arrives.
   */
  const settle = useCallback(() => {
    if (motion.reduced) {
      translateY.setValue(0);
      return;
    }
    Animated.spring(translateY, {
      toValue: 0,
      useNativeDriver: Platform.OS !== 'web',
      ...motion.spring,
    }).start();
  }, [motion.reduced, motion.spring, translateY]);

  const responder = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_event, gesture) =>
          draggable &&
          bodyAtTop.current &&
          gesture.dy > 6 &&
          Math.abs(gesture.dy) > Math.abs(gesture.dx),
        onPanResponderMove: (_event, gesture) => {
          // Downward only. An upward drag on a bottom sheet has nowhere to go.
          if (gesture.dy > 0) translateY.setValue(gesture.dy);
        },
        onPanResponderRelease: (_event, gesture) => {
          const dismissing =
            gesture.dy > DISMISS_DISTANCE || gesture.vy > DISMISS_VELOCITY;
          if (dismissing) {
            translateY.setValue(0);
            requestClose();
            return;
          }
          settle();
        },
        onPanResponderTerminate: settle,
      }),
    [draggable, requestClose, translateY, settle],
  );

  /**
   * `fit` is capped rather than sized: it takes its content's height and stops at 90%, at which
   * point the body scrolls. `medium` and `large` are heights, so their bodies fill and scroll.
   */
  const height =
    detent === 'large'
      ? { height: '90%' as const }
      : detent === 'medium'
        ? { height: '58%' as const }
        : { maxHeight: '90%' as const };

  return (
    <Modal
      visible={open}
      transparent
      animationType="fade"
      accessibilityLabel={title ?? 'Dialog'}
      // Hardware Back on Android and Escape on web arrive here — and go through the same guard.
      onRequestClose={dismissible ? requestClose : undefined}
    >
      <View
        /**
         * **The keyboard lifts the whole sheet, not just its content** (§6.2).
         *
         * The surface is bottom-anchored, so padding the scrim is what moves it clear — and it
         * moves the fixed actions slot with it. Lifting only the body would have left `Save`
         * behind the keyboard, which is the one control the user needs to finish the edit. The
         * percentage detents resolve against the remaining space, so a `medium` sheet also
         * shrinks rather than being pushed off the top.
         */
        style={{
          flex: 1,
          backgroundColor: theme.colors.scrim,
          justifyContent: centred ? 'center' : 'flex-end',
          alignItems: centred ? 'center' : 'stretch',
          paddingBottom: centred ? 0 : keyboard,
        }}
      >
        {/* The scrim itself dismisses, and is hidden from assistive tech — the close
            button is the accessible route out. */}
        <Pressable
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          onPress={dismissible ? requestClose : undefined}
          style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}
        />

        <Animated.View
          {...(Platform.OS === 'web' ? {} : { accessibilityViewIsModal: true })}
          testID={testID}
          style={[
            {
              backgroundColor: theme.colors.surfaceOverlay,
              /**
               * **The padding ratio**, read off the founder's frames and expressed on the 4 pt
               * scale (`14 / 20 / 24` there, `16 / 20 / 24` here): sides `space[6]`, top
               * `space[5]`, bottom `space[7]` plus the safe-area inset — which was missing
               * entirely, so on any device with a home indicator the last control sat under it.
               */
              paddingHorizontal: theme.space[6],
              paddingTop: theme.space[5],
              // The home indicator is irrelevant while the keyboard covers it.
              paddingBottom:
                theme.space[7] + (centred || keyboard > 0 ? 0 : insets.bottom),
              ...height,
              ...(centred
                ? { width: 480, maxWidth: '92%', borderRadius: theme.radius.sheet }
                : {
                    borderTopLeftRadius: theme.radius.sheet,
                    borderTopRightRadius: theme.radius.sheet,
                  }),
              transform: [{ translateY }],
            },
            theme.elevation('e3'),
          ]}
        >
          {/**
           * **The grabber is rendered only when it is true** (§0). It promises a drag, so it
           * appears exactly when there is one: a dismissible bottom sheet. The centred dialog
           * has neither, and a non-dismissible sheet has neither.
           *
           * The gesture lives on the header rather than the whole surface, so a drag starting on
           * a row or inside the body scrolls the body instead of moving the sheet — §25's
           * "scrollable content should scroll normally".
           */}
          <View {...(draggable ? responder.panHandlers : {})}>
            {draggable ? (
              <View
                aria-hidden
                accessibilityElementsHidden
                importantForAccessibility="no-hide-descendants"
                style={{
                  width: 38,
                  height: 4,
                  borderRadius: theme.radius.sm,
                  backgroundColor: theme.colors.border,
                  alignSelf: 'center',
                  marginBottom: theme.space[2],
                }}
                testID="sheet-grabber"
              />
            ) : null}

            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: theme.space[4],
                paddingBottom: theme.space[6],
              }}
            >
              {title === undefined ? (
                <View />
              ) : (
                // Serif, as the frames set every sheet heading.
                <Text variant="title" color="textDisplay" accessibilityRole="header">
                  {title}
                </Text>
              )}
              {dismissible ? (
                <IconButton icon={Close} label="Close" onPress={requestClose} />
              ) : null}
            </View>
          </View>

          {/**
           * The body scrolls; the header above and the actions below do not, so the commit stays
           * reachable however long the content is. Keyboard handling lives here rather than in
           * each modal, for the same reason the height does.
           */}
          <ScrollView
            ref={bodyRef}
            style={{ flexGrow: detent === 'fit' ? 0 : 1, flexShrink: 1 }}
            contentContainerStyle={{ gap: theme.space[6] }}
            automaticallyAdjustKeyboardInsets
            keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
            keyboardShouldPersistTaps="handled"
            scrollEventThrottle={16}
            onScroll={(event) => {
              bodyAtTop.current = event.nativeEvent.contentOffset.y <= 0;
            }}
            testID={testID === undefined ? undefined : `${testID}-body`}
          >
            {children}
          </ScrollView>

          {actions === undefined ? null : (
            <View
              style={{ gap: theme.space[3], paddingTop: theme.space[6] }}
              testID={testID === undefined ? undefined : `${testID}-actions`}
            >
              {actions}
            </View>
          )}
        </Animated.View>
      </View>
    </Modal>
  );
}
