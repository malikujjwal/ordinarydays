import { Modal, Pressable, View } from 'react-native';
import { Close } from '../icons/index';
import { useBreakpoint, useTheme } from '../theme/index';
import { IconButton } from './IconButton';
import { Text } from './Text';

/**
 * A modal surface (`design-system.md` §6, §8).
 *
 * **Bottom sheet at `compact`, centred dialog at `medium` and above** — the web layout uses
 * centred cards at 480 pt with no drag-to-dismiss, because a drag gesture on a desktop
 * pointer is a gesture nobody makes.
 *
 * Focus is trapped while open and returns to the trigger on close, which `Modal` gives us on
 * both platforms; the scrim is a real dismiss target so tapping outside closes, when
 * `dismissible`.
 */
export interface SheetProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: React.ReactNode;
  dismissible?: boolean;
  testID?: string;
}

export function Sheet({
  open,
  onClose,
  title,
  children,
  dismissible = true,
  testID,
}: SheetProps) {
  const theme = useTheme();
  const breakpoint = useBreakpoint();
  const centred = breakpoint !== 'compact';

  return (
    <Modal
      visible={open}
      transparent
      animationType="fade"
      onRequestClose={dismissible ? onClose : undefined}
    >
      <View
        style={{
          flex: 1,
          backgroundColor: theme.colors.scrim,
          justifyContent: centred ? 'center' : 'flex-end',
          alignItems: centred ? 'center' : 'stretch',
        }}
      >
        {/* The scrim itself dismisses, and is hidden from assistive tech — the close
            button is the accessible route out. */}
        <Pressable
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          onPress={dismissible ? onClose : undefined}
          style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}
        />

        <View
          accessibilityViewIsModal
          accessibilityRole={centred ? 'alert' : undefined}
          testID={testID}
          style={[
            {
              backgroundColor: theme.colors.surfaceOverlay,
              paddingHorizontal: theme.space[5],
              paddingVertical: theme.space[6],
              gap: theme.space[5],
              ...(centred
                ? { width: 480, maxWidth: '92%', borderRadius: theme.radius.sheet }
                : {
                    borderTopLeftRadius: theme.radius.sheet,
                    borderTopRightRadius: theme.radius.sheet,
                  }),
            },
            theme.elevation('e3'),
          ]}
        >
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: theme.space[4],
            }}
          >
            {title === undefined ? (
              <View />
            ) : (
              <Text variant="heading" color="textDisplay" accessibilityRole="header">
                {title}
              </Text>
            )}
            {dismissible ? (
              <IconButton icon={Close} label="Close" onPress={onClose} />
            ) : null}
          </View>

          {children}
        </View>
      </View>
    </Modal>
  );
}
