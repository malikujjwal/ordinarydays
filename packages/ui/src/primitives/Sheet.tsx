import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  Modal,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
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
import { shouldCaptureDrag, shouldDismissOnRelease } from './sheetGesture';
import {
  DIALOG_ENTER_SCALE,
  dragReleaseOutcome,
  runTransition,
  type SheetExit,
  type SheetPhase,
} from './sheetMotion';
import { Text } from './Text';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

export interface SheetVirtualizedBodyProps {
  /** Keeps the sheet's pull-to-dismiss gesture honest while the caller-owned list scrolls. */
  readonly onScroll: (event: NativeSyntheticEvent<NativeScrollEvent>) => void;
  readonly scrollEventThrottle: number;
}

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
 *
 * ## And its own motion (§4.3, P3-51)
 *
 * Present and dismiss are this component's, driven from `useMotion()`: `slow` / `decelerate`
 * in, `slow` / `accelerate` out, and `instant` under Reduce Motion without a branch here. They
 * were never `Modal`'s to give — React Native Web's fade ran at its own 250 ms, outside the
 * tokens, and withheld the dialog role until an `animationend` that never fired (see the
 * `animationType` note below). So the `Modal` mounts instantly on both platforms and the
 * surface and scrim animate themselves, and the modal stays mounted through the exit.
 *
 * **The owner decides** (review of 2026-09-02, amending P3-51's "wait for the exit before
 * `onClose`"): every control-driven close asks the owner through `onClose` at once and moves
 * nothing; the exit runs — then the unmount — when the owner drops `open`. An owner that
 * declines (a settings sheet whose ✕ means "back") keeps a visible sheet; a sheet that
 * unmounts with its route on `onClose` simply gets no exit, which it never had before P3-51
 * either.
 */
interface SheetBaseProps {
  open: boolean;
  onClose: () => void;
  /** Called after an owner-driven exit and, on iOS, its native modal dismissal have finished. */
  onClosed?: () => void;
  title?: string;
  /** Compact chrome for an editor whose scaled heading would consume its keyboard viewport. */
  compactTitle?: boolean;
  /** Persistent context or save feedback below the title, outside the scrolling body. */
  headerAccessory?: React.ReactNode;
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

export type SheetProps = SheetBaseProps &
  (
    | {
        /** Ordinary content; the Sheet owns its ScrollView. */
        children: React.ReactNode;
        virtualizedBody?: never;
      }
    | {
        children?: never;
        /**
         * A paginated body must own its FlatList rather than nest it inside the Sheet ScrollView.
         * The supplied scroll props preserve the same top-of-body drag arbitration.
         */
        virtualizedBody: (props: SheetVirtualizedBodyProps) => React.ReactNode;
      }
  );

export function Sheet({
  open,
  onClose,
  onClosed,
  title,
  compactTitle = false,
  headerAccessory,
  children,
  virtualizedBody,
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
  const centred = breakpoint !== 'compact';
  // The home indicator is irrelevant while the keyboard covers it.
  const surfacePaddingBottom =
    theme.space[7] + (centred || keyboard > 0 ? 0 : insets.bottom);
  const [actionsHeight, setActionsHeight] = useState(0);
  /**
   * **The keyboard is handled once** (§6.2). A bottom sheet lifts its whole surface, so its body
   * takes no platform keyboard inset; keeping a focused field visible is scroll-to-focused's job,
   * and it has to know what sits between the body and the keyboard — the actions slot and the
   * surface's bottom padding. The centred dialog does not lift, so the platform keeps that job
   * there and the footer stays `0`.
   */
  const liftsForKeyboard = !centred;
  useScrollToFocusedInput(
    bodyRef,
    keyboard,
    viewportHeight,
    0,
    liftsForKeyboard
      ? (actions === undefined ? 0 : actionsHeight) + surfacePaddingBottom
      : 0,
  );

  /** Only a bottom sheet drags, and only when it is allowed to close at all. */
  const draggable = !centred && dismissible;

  /** The finger's offset while dragging. Separate from the entrance so the two compose. */
  const dragY = useRef(new Animated.Value(0)).current;
  /** `0` fully away, `1` fully present. Drives the scrim and the surface's entrance/exit. */
  const progress = useRef(new Animated.Value(0)).current;
  /**
   * Whether the body is scrolled to its top. **This is what stops the gesture being ambiguous**
   * (§25): mid-scroll, a downward drag scrolls the content; at the top, it dismisses. Without
   * it a pull-down inside a long choice list would fight the list.
   */
  const bodyAtTop = useRef(true);
  const onBodyScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    bodyAtTop.current = event.nativeEvent.contentOffset.y <= 0;
  }, []);
  const hasVirtualizedBody = virtualizedBody !== undefined;
  const previousBodyOwnership = useRef(hasVirtualizedBody);
  useEffect(() => {
    if (previousBodyOwnership.current === hasVirtualizedBody) return;
    previousBodyOwnership.current = hasVirtualizedBody;
    bodyAtTop.current = true;
  }, [hasVirtualizedBody]);

  /**
   * The lifecycle the motion needs and `open` alone cannot express: the modal has to stay
   * mounted while it leaves. `phase` is state because the mounted-ness renders; `phaseRef`
   * mirrors it for the effects and handlers that must read the latest value without
   * re-subscribing.
   */
  const [phase, setPhase] = useState<SheetPhase>(open ? 'presenting' : 'closed');
  const phaseRef = useRef<SheetPhase>(phase);
  const movePhase = useCallback((next: SheetPhase) => {
    phaseRef.current = next;
    setPhase(next);
  }, []);
  /** How the current exit leaves — `fade` after a drag, `travel` otherwise. */
  const [exit, setExit] = useState<SheetExit>('travel');
  /**
   * The bottom sheet's travel distance: its own height once measured, the viewport until then.
   * Layout reports before the first frame in practice, so a `fit` sheet slides in from just
   * below its resting place rather than from the bottom of the screen; if it ever reported
   * late, the remaining travel would shorten once, never lengthen.
   */
  const [surfaceHeight, setSurfaceHeight] = useState<number | null>(null);
  const cancelTransition = useRef<() => void>(() => {});

  /** How the next owner-driven exit leaves: `fade` once a drag has released past the threshold. */
  const pendingExit = useRef<SheetExit>('travel');

  const present = useCallback(() => {
    cancelTransition.current();
    // A re-present mid-exit starts from rest, whatever the interrupted exit had left behind.
    bodyAtTop.current = true;
    dragY.setValue(0);
    setExit('travel');
    pendingExit.current = 'travel';
    movePhase('presenting');
    cancelTransition.current = runTransition(
      progress,
      { toValue: 1, duration: motion.duration.slow, easing: motion.easing.decelerate },
      () => movePhase('open'),
    );
  }, [dragY, motion.duration.slow, motion.easing.decelerate, movePhase, progress]);

  /**
   * Leave, then tell whoever asked. `onDone` runs **after** the exit, which is the whole
   * point: a sheet whose route unmounts on `onClose` would otherwise vanish mid-frame.
   */
  const dismiss = useCallback(
    (how: SheetExit, onDone?: () => void) => {
      cancelTransition.current();
      setExit(how);
      movePhase('dismissing');
      cancelTransition.current = runTransition(
        progress,
        { toValue: 0, duration: motion.duration.slow, easing: motion.easing.accelerate },
        () => {
          movePhase('closed');
          dragY.setValue(0);
          setExit('travel');
          onDone?.();
          // iOS dismisses its view controller asynchronously; web also unmounts its focus
          // trap after this frame. Both report onDismiss below, so restored editor focus
          // is not subsequently stolen by the closing modal. Android has no onDismiss.
          if (Platform.OS === 'android') onClosed?.();
        },
      );
    },
    [
      dragY,
      motion.duration.slow,
      motion.easing.accelerate,
      movePhase,
      onClosed,
      progress,
    ],
  );

  /**
   * `open` is the owner's word. Rising presents; falling animates out and unmounts — which
   * covers an owner that closes on its own (after a save, say) without going through this
   * component's controls. A fall that arrives while a control-driven exit is already under way
   * changes nothing: that exit finishes and reports. Initial mount with `open` already true
   * is a rise, so the first render is already `presenting` (no closed frame) and the tween
   * starts here.
   */
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open && !wasOpen.current) {
      wasOpen.current = true;
      present();
      return;
    }
    if (!open && wasOpen.current) {
      wasOpen.current = false;
      if (phaseRef.current === 'open' || phaseRef.current === 'presenting') {
        const how = pendingExit.current;
        pendingExit.current = 'travel';
        dismiss(how);
      }
    }
  }, [open, present, dismiss]);

  useEffect(() => () => cancelTransition.current(), []);

  /**
   * **The owner decides.** Every control-driven close — ✕, scrim, Escape, hardware Back, a
   * drag past the threshold — asks the owner through `onClose` and changes nothing itself;
   * the exit runs when the owner drops `open`. An owner that declines (a settings sheet whose
   * ✕ means "back to the main editor") keeps a visible sheet, which is the contract every
   * consumer was written against. A sheet already leaving takes no further requests, so a
   * discard prompt cannot be re-raised over an exit.
   */
  const requestClose = useCallback(() => {
    if (phaseRef.current === 'dismissing' || phaseRef.current === 'closed') return;
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
      dragY.setValue(0);
      return;
    }
    Animated.spring(dragY, {
      toValue: 0,
      useNativeDriver: Platform.OS !== 'web',
      ...motion.spring,
    }).start();
  }, [motion.reduced, motion.spring, dragY]);

  const responder = useMemo(
    () =>
      PanResponder.create({
        /**
         * **Capture, and on the whole surface** — not `onMoveShouldSetPanResponder` on the
         * header alone.
         *
         * §6.1 says the drag "engages only while the body is scrolled to its top", and that
         * clause was dead: bound to the header, which never scrolls, the condition could never
         * decide anything, and a swipe down starting on a row — the gesture everyone actually
         * makes — did nothing at all. Reported from the built sheet and reproduced: a touch
         * drag on the title dismissed, the identical drag from a date row did not.
         *
         * Capturing is what makes `bodyAtTop` the arbiter rather than the scroll view. Without
         * it the `ScrollView` claims the gesture first and a downward drag at offset zero is
         * swallowed by a list with nowhere to go. With it, the two readings of one gesture
         * separate cleanly: at the top the sheet moves, mid-scroll the body scrolls.
         *
         * The threshold still guards the child controls — a tap, or any drag under 6 pt, never
         * reaches here, so a date row's press is unaffected.
         */
        onMoveShouldSetPanResponderCapture: (_event, gesture) =>
          shouldCaptureDrag(gesture, { draggable, bodyAtTop: bodyAtTop.current }),
        onPanResponderMove: (_event, gesture) => {
          // Downward only. An upward drag on a bottom sheet has nowhere to go.
          if (gesture.dy > 0) dragY.setValue(gesture.dy);
        },
        onPanResponderRelease: (_event, gesture) => {
          const outcome = dragReleaseOutcome(shouldDismissOnRelease(gesture), dirty);
          if (outcome === 'settle') {
            settle();
            return;
          }
          if (outcome === 'settle-then-discard') {
            settle();
            requestClose();
            return;
          }
          /**
           * Already at its final offset: the exit is opacity only, from wherever the finger
           * left it. Snapping to rest first would undo the gesture just made (§4.3). The
           * owner is still the one to drop `open`; only the manner of leaving is decided here.
           */
          if (phaseRef.current === 'dismissing' || phaseRef.current === 'closed') return;
          pendingExit.current = 'fade';
          onClose();
        },
        onPanResponderTerminate: settle,
      }),
    [draggable, dirty, requestClose, onClose, dragY, settle],
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

  /**
   * Two resolved treatments from one value, no second component: the dialog fades and settles
   * from a slight scale; the bottom sheet travels — unless it is leaving by `fade`, when its
   * offset holds and only its opacity goes.
   */
  const travel = surfaceHeight ?? viewportHeight;
  const entrance = progress.interpolate({ inputRange: [0, 1], outputRange: [travel, 0] });
  const surfaceMotion = centred
    ? {
        opacity: progress,
        transform: [
          {
            scale: progress.interpolate({
              inputRange: [0, 1],
              outputRange: [DIALOG_ENTER_SCALE, 1],
            }),
          },
        ],
      }
    : exit === 'fade'
      ? { opacity: progress, transform: [{ translateY: dragY }] }
      : { transform: [{ translateY: Animated.add(dragY, entrance) }] };

  return (
    <Modal
      visible={phase !== 'closed'}
      transparent
      /**
       * **`none`, on both platforms — and on web that is an accessibility fix, not a taste.**
       *
       * React Native Web's `Modal` marks itself *active* only when its own show animation
       * ends, and until it does it writes `aria-modal="true"` with **no** `role="dialog"` and
       * runs no focus trap. That end event never arrives here: measured in Chromium against
       * the built export, the container still had `role: null` two seconds after mount, which
       * axe reports as `aria-allowed-attr` — a **critical** violation on every sheet in the
       * product, and a modal that assistive technology is not told is modal.
       *
       * With no animation type, RNW completes that lifecycle synchronously on mount, so the
       * dialog role and the focus trap both exist (P3-26). The motion the §4.3 row asks for is
       * this component's own, above: it animates the surface and the scrim inside a modal that
       * mounted instantly, so nothing here waits on an event that never comes. Native drops
       * its fade for the same reason — one animation, ours, under `useMotion()`.
       */
      animationType="none"
      accessibilityLabel={title ?? 'Dialog'}
      // Hardware Back on Android and Escape on web arrive here — and go through the same guard.
      onRequestClose={dismissible ? requestClose : undefined}
      {...(Platform.OS !== 'android' && onClosed !== undefined
        ? { onDismiss: onClosed }
        : {})}
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
          justifyContent: centred ? 'center' : 'flex-end',
          alignItems: centred ? 'center' : 'stretch',
          paddingBottom: liftsForKeyboard ? keyboard : 0,
          // A leaving sheet is not a target: a second tap on a row mid-exit dispatches nothing.
          pointerEvents: phase === 'dismissing' ? 'none' : 'auto',
        }}
      >
        {/* The scrim itself dismisses, and is hidden from assistive tech — the close
            button is the accessible route out. It carries the scrim colour so it can fade
            with the surface. */}
        <AnimatedPressable
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          onPress={dismissible ? requestClose : undefined}
          testID={testID === undefined ? undefined : `${testID}-scrim`}
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: theme.colors.scrim,
            opacity: progress,
          }}
        />

        <Animated.View
          {...(Platform.OS === 'web' ? {} : { accessibilityViewIsModal: true })}
          {...(draggable ? responder.panHandlers : {})}
          testID={testID}
          onLayout={(event) => {
            const measured = event.nativeEvent.layout.height;
            if (measured > 0 && measured !== surfaceHeight) setSurfaceHeight(measured);
          }}
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
              paddingBottom: surfacePaddingBottom,
              ...height,
              ...(centred
                ? { width: 480, maxWidth: '92%', borderRadius: theme.radius.sheet }
                : {
                    borderTopLeftRadius: theme.radius.sheet,
                    borderTopRightRadius: theme.radius.sheet,
                  }),
              ...surfaceMotion,
            },
            theme.elevation('e3'),
          ]}
        >
          {/**
           * **The grabber is rendered only when it is true** (§0). It promises a drag, so it
           * appears exactly when there is one: a dismissible bottom sheet. The centred dialog
           * has neither, and a non-dismissible sheet has neither.
           *
           * The gesture itself lives on the surface above, so a swipe down from anywhere on the
           * sheet dismisses it while the body is at its top; the grabber says so.
           */}
          <View>
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
                paddingBottom: compactTitle ? theme.space[3] : theme.space[6],
              }}
            >
              {title === undefined ? (
                <View />
              ) : (
                // Serif, as the frames set every sheet heading.
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text
                    variant={compactTitle ? 'footnoteStrong' : 'title'}
                    color="textDisplay"
                    accessibilityRole="header"
                    numberOfLines={0}
                  >
                    {title}
                  </Text>
                </View>
              )}
              {dismissible ? (
                <IconButton icon={Close} label="Close" onPress={requestClose} />
              ) : null}
            </View>
            {headerAccessory}
          </View>

          {/**
           * The body scrolls; the header above and the actions below do not, so the commit stays
           * reachable however long the content is. Keyboard handling lives here rather than in
           * each modal, for the same reason the height does.
           *
           * **No platform keyboard inset under a lifted surface.** iOS would judge the overlap
           * against the body's pre-lift frame and shift the content by the focused field's
           * distance below the keyboard's top; a short `fit` body is smaller than that shift, so
           * its only field scrolled out of sight while the title and buttons stayed.
           */}
          {virtualizedBody === undefined ? (
            <ScrollView
              ref={bodyRef}
              nativeID={testID === undefined ? undefined : `${testID}-owned-scroll-body`}
              style={{ flexGrow: detent === 'fit' ? 0 : 1, flexShrink: 1 }}
              contentContainerStyle={{ gap: theme.space[6] }}
              automaticallyAdjustKeyboardInsets={!liftsForKeyboard}
              keyboardDismissMode={
                Platform.OS === 'ios'
                  ? 'interactive'
                  : Platform.OS === 'web'
                    ? 'none'
                    : 'on-drag'
              }
              keyboardShouldPersistTaps="handled"
              scrollEventThrottle={16}
              onScroll={onBodyScroll}
              testID={testID === undefined ? undefined : `${testID}-body`}
            >
              {children}
            </ScrollView>
          ) : (
            <View
              style={{ flexGrow: detent === 'fit' ? 0 : 1, flexShrink: 1 }}
              testID={testID === undefined ? undefined : `${testID}-body`}
            >
              {virtualizedBody({ onScroll: onBodyScroll, scrollEventThrottle: 16 })}
            </View>
          )}

          {actions === undefined ? null : (
            <View
              onLayout={(event) => setActionsHeight(event.nativeEvent.layout.height)}
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
