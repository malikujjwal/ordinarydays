import { Toast, useTheme } from '@od/ui';
import { View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useToast } from '@/stores/toast';

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
  const current = useToast((s) => s.current);
  const dismiss = useToast((s) => s.dismiss);

  if (current === undefined) return null;

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
        onDismiss={dismiss}
        {...(current.tone === undefined ? {} : { tone: current.tone })}
        {...(current.action === undefined ? {} : { action: current.action })}
      />
    </View>
  );
}
