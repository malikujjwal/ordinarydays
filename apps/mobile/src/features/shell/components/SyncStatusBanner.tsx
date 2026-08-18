import { Card, Text, useTheme } from '@od/ui';
import { View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useBlockedIntents } from '@/hooks/usePendingIntents';
import { useSyncStatus } from '@/stores/syncStatus';

/** One app-level banner aggregates replay conflicts instead of emitting a toast per field. */
export function SyncStatusBanner() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const queueMessage = useSyncStatus((state) => state.queueMessage);
  const conflictChanges = useSyncStatus((state) => state.conflictChanges);
  /**
   * Intents the queue could not land (P2-48).
   *
   * Structured `needs_attention` covers permanent rejection and writes parked by age or an
   * untrusted clock. Both hold words the user typed and both are retained until the user
   * acts, so both belong in the one banner §5.4 already specifies rather than in a second
   * surface. The count is of writes, which is what `<n> changes` means here.
   */
  const blocked = useBlockedIntents();

  if (queueMessage === undefined && conflictChanges.length === 0 && blocked.length === 0)
    return null;

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
          {blocked.length === 0 ? null : (
            <Text variant="subhead" color="textPrimary" testID="blocked-intents">
              {`${blocked.length} ${blocked.length === 1 ? 'change' : 'changes'} couldn't be applied.`}
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
