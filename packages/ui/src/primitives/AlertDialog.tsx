import { type ReactNode, useEffect, useRef } from 'react';
import { Modal, Platform, View } from 'react-native';
import { useMotion, useTheme } from '../theme/index';

export interface AlertDialogProps {
  open: boolean;
  label: string;
  children: ReactNode;
  onRequestClose: () => void;
  /** The safe action receives initial keyboard focus when the alert opens. */
  initialFocusTestID?: string;
  testID?: string;
}

/**
 * The shared, non-dismissible-scrim alert surface for consequential decisions.
 *
 * `Modal` isolates the accessibility tree on native. On web, this primitive also owns the
 * initial safe focus, Tab loop and trigger restoration so feature dialogs cannot implement
 * only one of the three.
 */
export function AlertDialog({
  open,
  label,
  children,
  onRequestClose,
  initialFocusTestID,
  testID = 'alert-dialog',
}: AlertDialogProps) {
  const theme = useTheme();
  const motion = useMotion();
  const returnFocus = useRef<HTMLElement | null>(null);
  const wasOpen = useRef(false);

  if (
    Platform.OS === 'web' &&
    open &&
    !wasOpen.current &&
    typeof document !== 'undefined' &&
    document.activeElement instanceof HTMLElement
  ) {
    returnFocus.current = document.activeElement;
  }
  wasOpen.current = open;

  useEffect(() => {
    if (!open || Platform.OS !== 'web') return;
    const dialog = document.querySelector<HTMLElement>(`[data-testid="${testID}"]`);
    if (dialog === null) return;

    const focusable = () =>
      Array.from(
        dialog.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      );
    const initial =
      initialFocusTestID === undefined
        ? focusable()[0]
        : dialog.querySelector<HTMLElement>(`[data-testid="${initialFocusTestID}"]`);
    initial?.focus();

    const trapFocus = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      const controls = focusable();
      const first = controls[0];
      const last = controls.at(-1);
      if (first === undefined || last === undefined) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', trapFocus, true);
    return () => {
      document.removeEventListener('keydown', trapFocus, true);
      const trigger = returnFocus.current;
      returnFocus.current = null;
      // RN Web moves focus to its modal sentinel while the portal tears down. Restore after
      // that synchronous teardown so the sentinel cannot overwrite the user's trigger.
      setTimeout(() => trigger?.focus(), 0);
    };
  }, [initialFocusTestID, open, testID]);

  return (
    <Modal
      visible={open}
      transparent
      animationType={Platform.OS === 'web' || motion.reduced ? 'none' : 'fade'}
      accessibilityLabel={label}
      onRequestClose={onRequestClose}
    >
      <View
        style={{
          flex: 1,
          alignItems: 'center',
          justifyContent: 'center',
          padding: theme.space[5],
          backgroundColor: theme.colors.scrim,
        }}
      >
        <View
          role="alertdialog"
          aria-modal
          accessibilityLabel={label}
          accessibilityViewIsModal
          testID={testID}
          style={[
            {
              width: '100%',
              maxWidth: theme.layout.alertDialogMaxWidth,
              padding: theme.space[6],
              borderRadius: theme.radius.sheet,
              backgroundColor: theme.colors.surfaceOverlay,
            },
            theme.elevation('e3'),
          ]}
        >
          {children}
        </View>
      </View>
    </Modal>
  );
}
