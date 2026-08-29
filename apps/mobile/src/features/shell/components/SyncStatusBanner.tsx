import { Button, Card, Text, useTheme } from '@od/ui';
import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  discardBlockedIntent,
  retryBlockedIntent,
  useBlockedIntents,
} from '@/hooks/usePendingIntents';
import { useSyncStatus } from '@/stores/syncStatus';

/** One app-level banner aggregates replay conflicts instead of emitting a toast per field. */
export function SyncStatusBanner() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const queueMessage = useSyncStatus((state) => state.queueMessage);
  const conflictChanges = useSyncStatus((state) => state.conflictChanges);
  /**
   * Intents the queue could not land, including a recurrence write whose latest automatic
   * attempt failed (P2-48).
   *
   * Structured `needs_attention` covers permanent rejection and writes parked by age or an
   * untrusted clock. A retryable recurrence failure remains queued for automatic recovery,
   * but it also needs an explicit escape hatch because that write keeps occurrence controls
   * inert. All of them belong in the one account-level banner §5.4 already specifies rather
   * than in a second subscription surface. The count is of writes, which is what `<n>
   * changes` means here.
   */
  const blocked = useBlockedIntents();
  const [actingOn, setActingOn] = useState<string>();
  const [actionError, setActionError] = useState<string>();
  const [resolvedIntentIds, setResolvedIntentIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );

  useEffect(() => {
    const blockedIds = new Set(blocked.map((intent) => intent.intentId));
    setResolvedIntentIds((current) => {
      const next = new Set([...current].filter((intentId) => blockedIds.has(intentId)));
      return next.size === current.size ? current : next;
    });
  }, [blocked]);

  const visibleBlocked = blocked.filter(
    (intent) => !resolvedIntentIds.has(intent.intentId),
  );

  async function recover(intentId: string, action: 'retry' | 'discard') {
    setActingOn(intentId);
    setActionError(undefined);
    try {
      const succeeded =
        action === 'retry'
          ? await retryBlockedIntent(intentId)
          : await discardBlockedIntent(intentId);
      if (succeeded) {
        setResolvedIntentIds((current) => new Set(current).add(intentId));
      } else {
        setActionError("Couldn't refresh the latest data. Check your connection.");
      }
    } catch {
      setActionError("Couldn't update that change. Try again.");
    } finally {
      setActingOn(undefined);
    }
  }

  if (
    queueMessage === undefined &&
    conflictChanges.length === 0 &&
    visibleBlocked.length === 0
  )
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
          {visibleBlocked.length === 0 ? null : (
            <View style={{ gap: theme.space[3] }} testID="blocked-intents">
              <Text variant="subhead" color="textPrimary">
                {visibleBlocked.length === 1
                  ? "1 change couldn't be applied."
                  : `${visibleBlocked.length} changes couldn't be applied.`}
              </Text>
              {visibleBlocked.map((intent) => (
                <View key={intent.intentId} style={{ gap: theme.space[2] }}>
                  <Text variant="footnote" color="textSecondary">
                    {intent.lastError ?? intent.mutationKey.slice(1).join(' ')}
                  </Text>
                  <View style={{ flexDirection: 'row', gap: theme.space[2] }}>
                    <Button
                      label="Retry"
                      variant="secondary"
                      loading={actingOn === intent.intentId}
                      onPress={() => void recover(intent.intentId, 'retry')}
                      testID={`retry-intent-${intent.intentId}`}
                    />
                    <Button
                      label="Discard"
                      variant="ghost"
                      disabled={actingOn === intent.intentId}
                      onPress={() => void recover(intent.intentId, 'discard')}
                      testID={`discard-intent-${intent.intentId}`}
                    />
                  </View>
                </View>
              ))}
              {actionError === undefined ? null : (
                <Text variant="footnote" color="danger">
                  {actionError}
                </Text>
              )}
            </View>
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
