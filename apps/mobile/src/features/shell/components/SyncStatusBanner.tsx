import { Card, Text, useTheme } from '@od/ui';
import { View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useSyncStatus } from '@/stores/syncStatus';

/** One app-level banner aggregates replay conflicts instead of emitting a toast per field. */
export function SyncStatusBanner() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const queueMessage = useSyncStatus((state) => state.queueMessage);
  const conflictChanges = useSyncStatus((state) => state.conflictChanges);

  if (queueMessage === undefined && conflictChanges.length === 0) return null;

  return (
    <View
      accessibilityLiveRegion="polite"
      accessibilityRole="alert"
      testID="sync-status-banner"
      style={{
        position: 'absolute',
        top: insets.top + theme.space[3],
        left: theme.space[5],
        right: theme.space[5],
        zIndex: 100,
      }}
    >
      <Card elevation="e2" radius="lg" padding={5}>
        <View style={{ gap: theme.space[2] }}>
          {queueMessage === undefined ? null : (
            <Text variant="subhead" color="textPrimary">
              {queueMessage}
            </Text>
          )}
          {conflictChanges.length === 0 ? null : (
            <>
              <Text variant="subhead" color="textPrimary">
                {conflictChanges.length} changes couldn't be applied.
              </Text>
              {conflictChanges.map((change) => (
                <Text key={change} variant="footnote" color="textSecondary">
                  {`• ${change}`}
                </Text>
              ))}
            </>
          )}
        </View>
      </Card>
    </View>
  );
}
