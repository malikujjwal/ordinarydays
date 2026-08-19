import { Button, Skeleton, Text, useTheme } from '@od/ui';
import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { View } from 'react-native';
import {
  restorePersistedClient as defaultRestore,
  subscribeToPersistence as defaultSubscribe,
} from '@/lib/persister';
import { queryClient } from '@/lib/queryClient';
import { startNativeStateSession as defaultStartSession } from '@/lib/sqlite/nativeStateSession';

export const STARTUP_ERROR_MESSAGE = "Couldn't open your data.";

export interface HydrationGateProps {
  children: ReactNode;
  /**
   * Installs the services that must not run before the session exists (connectivity,
   * local reminder scheduling) and returns their teardown. Injected by the route layout
   * because those live in feature slices this shared component may not import.
   */
  install: () => () => void;
  restore?: typeof defaultRestore;
  startSession?: typeof defaultStartSession;
  subscribe?: typeof defaultSubscribe;
}

/**
 * Holds the tree on a skeleton until the persisted cache is restored and the native SQLite
 * session is open, and holds the *saving* of the cache until that is provably safe.
 *
 * A start that fails must degrade to a visible, retryable error — never a permanent
 * skeleton. `startNativeStateSession` clears its singleton bookkeeping when it rejects, so
 * re-running the whole sequence is the sanctioned retry; `restorePersistedClient` merges
 * into the live client and is safe to repeat.
 */
export function HydrationGate({
  children,
  install,
  restore = defaultRestore,
  startSession = defaultStartSession,
  subscribe = defaultSubscribe,
}: HydrationGateProps) {
  const theme = useTheme();
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    void attempt;
    let active = true;
    let stopPersistence: (() => void) | undefined;
    let stopServices: (() => void) | undefined;
    let stopNativeState: (() => void) | undefined;

    void restore(queryClient)
      .then(async (outcome) => {
        if (!active) return;
        /**
         * `outcome.safeToPersist` is what stops a slow storage read being overwritten by
         * the empty client that was rendering while it was still in flight. The app
         * becomes interactive now either way; only the *saving* waits.
         */
        const nativeSession = await startSession(queryClient);
        if (!active) {
          nativeSession?.stop();
          return;
        }
        stopNativeState = nativeSession?.stop;
        if (nativeSession?.queryPersistenceSafe !== false) {
          stopPersistence = subscribe(queryClient, outcome.safeToPersist);
        }
        stopServices = install();
        setReady(true);
      })
      .catch((error: unknown) => {
        if (!active) return;
        console.warn(
          'native_state_session_failed',
          error instanceof Error ? error.message : String(error),
        );
        setFailed(true);
      });

    return () => {
      active = false;
      stopPersistence?.();
      stopServices?.();
      stopNativeState?.();
    };
  }, [attempt, install, restore, startSession, subscribe]);

  const retry = useCallback(() => {
    setFailed(false);
    setAttempt((current) => current + 1);
  }, []);

  if (!ready) {
    if (failed) {
      return (
        <View
          testID="startup-error"
          accessible
          accessibilityLabel={STARTUP_ERROR_MESSAGE}
          accessibilityLiveRegion="polite"
          style={{
            flex: 1,
            justifyContent: 'center',
            gap: theme.space[4],
            paddingHorizontal: theme.space[6],
            backgroundColor: theme.colors.surface,
          }}
        >
          <Text variant="subhead" color="textPrimary" numberOfLines={0}>
            {STARTUP_ERROR_MESSAGE}
          </Text>
          <Button
            label="Retry"
            variant="secondary"
            onPress={retry}
            testID="startup-retry"
          />
        </View>
      );
    }
    return (
      <View
        testID="cache-hydration-loading"
        style={{
          flex: 1,
          justifyContent: 'center',
          paddingHorizontal: theme.space[6],
          backgroundColor: theme.colors.surface,
        }}
      >
        <Skeleton shape="row" count={5} />
      </View>
    );
  }

  return <>{children}</>;
}
