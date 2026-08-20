import { CloudCheck, CloudOff, CloudSync, Text, useTheme } from '@od/ui';
import { useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import { useIsOffline, usePendingIntents } from '@/hooks/usePendingIntents';

const SYNCED_VISIBLE_MS = 2_000;

type ConnectivityState =
  | { kind: 'offline'; label: 'Offline' }
  | { kind: 'waiting'; label: string }
  | { kind: 'syncing'; label: 'Syncing…' }
  | { kind: 'synced'; label: 'Synced' };

/**
 * Quiet, non-blocking connectivity feedback for a tab header.
 *
 * The durable outbox remains the source of truth. `needs_attention` is deliberately excluded
 * from "waiting" and "syncing": those writes will not replay without user action and already
 * have the app-level recovery banner. Calling them active would leave "Syncing…" on screen
 * forever after a rejection.
 */
export function ConnectivityStatus() {
  const theme = useTheme();
  const offline = useIsOffline();
  const intents = usePendingIntents();
  const waitingCount = intents.reduce(
    (count, intent) =>
      intent.status === 'queued' || intent.status === 'in_flight' ? count + 1 : count,
    0,
  );
  const blockedCount = intents.length - waitingCount;
  const hadWaiting = useRef(waitingCount > 0);
  const [showSynced, setShowSynced] = useState(false);

  useEffect(() => {
    if (offline) {
      hadWaiting.current = waitingCount > 0;
      setShowSynced(false);
      return;
    }

    if (waitingCount > 0) {
      hadWaiting.current = true;
      setShowSynced(false);
      return;
    }

    if (blockedCount > 0 || !hadWaiting.current) {
      hadWaiting.current = false;
      setShowSynced(false);
      return;
    }

    hadWaiting.current = false;
    setShowSynced(true);
    const timer = setTimeout(() => setShowSynced(false), SYNCED_VISIBLE_MS);
    return () => clearTimeout(timer);
  }, [blockedCount, offline, waitingCount]);

  const settledThisRender =
    !offline && waitingCount === 0 && blockedCount === 0 && hadWaiting.current;
  let state: ConnectivityState | undefined;
  if (offline) {
    state =
      waitingCount === 0
        ? { kind: 'offline', label: 'Offline' }
        : { kind: 'waiting', label: `${waitingCount} waiting` };
  } else if (waitingCount > 0) {
    state = { kind: 'syncing', label: 'Syncing…' };
  } else if (showSynced || settledThisRender) {
    state = { kind: 'synced', label: 'Synced' };
  }

  if (state === undefined) return null;

  const Icon =
    state.kind === 'synced'
      ? CloudCheck
      : state.kind === 'syncing'
        ? CloudSync
        : CloudOff;
  const accessibilityLabel =
    state.kind === 'waiting'
      ? waitingCount === 1
        ? '1 change waiting to sync'
        : `${waitingCount} changes waiting to sync`
      : state.label.replace('…', '');

  return (
    <View
      accessible
      accessibilityLabel={accessibilityLabel}
      accessibilityLiveRegion="polite"
      testID="connectivity-status"
      style={{
        minWidth: 0,
        flexShrink: 1,
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space[1],
      }}
    >
      <View
        aria-hidden
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      >
        <Icon size={16} color={theme.colors.textSecondary} />
      </View>
      <Text variant="footnoteStrong" color="textSecondary" numberOfLines={1}>
        {state.label}
      </Text>
    </View>
  );
}
