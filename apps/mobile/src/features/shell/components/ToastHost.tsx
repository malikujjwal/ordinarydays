import { Toast, useTheme } from '@od/ui';
import { useCallback, useEffect } from 'react';
import { Platform, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useClock } from '@/hooks/useClock';
import { useToast } from '@/stores/toast';

const DEFAULT_TOAST_DURATION_MS = 6000;

/**
 * Renders the one active toast above the tab bar.
 *
 * Mounted once in the app group's layout, so a toast survives the screen that raised it and
 * never appears twice. `pointerEvents="box-none"` on the wrapper is what keeps the empty
 * space around it from swallowing taps on the content underneath — a full-bleed overlay that
 * eats touches is the standard way this component goes wrong.
 */
export function ToastHost() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const clock = useClock();
  const current = useToast((s) => s.current);
  const dismiss = useToast((s) => s.dismiss);
  const undo = useToast((s) => s.undo);

  const remainingDuration =
    current === undefined
      ? undefined
      : current.kind === 'undo' && current.undoExpiresAt !== undefined
        ? Math.min(
            current.duration ?? DEFAULT_TOAST_DURATION_MS,
            Date.parse(current.undoExpiresAt) - Date.parse(clock.now()),
          )
        : (current.duration ?? DEFAULT_TOAST_DURATION_MS);

  const acceptUndo = useCallback(() => {
    if (current?.kind !== 'undo') return;
    if (
      current.undoExpiresAt !== undefined &&
      Date.parse(clock.now()) >= Date.parse(current.undoExpiresAt)
    ) {
      dismiss(current.id);
      return;
    }
    undo(current.id);
  }, [clock, current, dismiss, undo]);

  useEffect(() => {
    if (Platform.OS !== 'web' || current?.kind !== 'undo') return;
    const predecessor = document.activeElement;
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        acceptUndo();
        return;
      }
      if (
        event.key === 'Tab' &&
        !event.shiftKey &&
        document.activeElement === predecessor
      ) {
        const action = document.querySelector<HTMLElement>(
          '[data-testid="toast-action"]',
        );
        if (action !== null) {
          event.preventDefault();
          action.focus();
        }
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [acceptUndo, current]);

  if (
    current === undefined ||
    remainingDuration === undefined ||
    remainingDuration <= 0
  ) {
    return null;
  }

  return (
    <View
      testID="toast-host"
      style={{
        // In `style`, not as a prop: `props.pointerEvents` is deprecated in RN 0.81.
        pointerEvents: 'box-none',
        position: 'absolute',
        left: theme.space[5],
        right: theme.space[5],
        // Clear of the tab bar and the home indicator.
        bottom: insets.bottom + theme.space[11],
      }}
    >
      <Toast
        message={current.message}
        {...(current.kind !== 'message' || current.requestId === undefined
          ? {}
          : { requestId: current.requestId })}
        {...(current.kind === 'message' && current.tone !== undefined
          ? { tone: current.tone }
          : {})}
        {...(current.kind === 'undo'
          ? {
              action: {
                label: 'Undo',
                onPress: acceptUndo,
              },
            }
          : current.action === undefined
            ? {}
            : { action: current.action })}
      />
    </View>
  );
}
