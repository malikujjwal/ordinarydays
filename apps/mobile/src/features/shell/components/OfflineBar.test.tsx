import { ThemeProvider } from '@od/ui';
import { onlineManager } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IntentLog, type IntentLogStorage } from '@/lib/intentLog';
import { setActiveIntentLog } from '@/lib/intentReplay';
import { OfflineBar } from './OfflineBar';
import { PendingIndicator } from './PendingIndicator';
import { SyncStatusBanner } from './SyncStatusBanner';

const USER = 'usr_01J0000000000000000000000A';
const ACTIVITY = 'act_01J0000000000000000000000C';

function memoryStorage(): IntentLogStorage {
  const data = new Map<string, string>();
  return {
    getItem: async (key) => data.get(key) ?? null,
    setItem: async (key, value) => {
      data.set(key, value);
    },
    removeItem: async (key) => {
      data.delete(key);
    },
  };
}

async function logWithIntent(entityId = ACTIVITY): Promise<IntentLog> {
  const log = new IntentLog(USER, memoryStorage());
  await log.hydrate();
  await log.append({
    intentId: `intent-${entityId}`,
    mutationKey: ['activity', 'complete'],
    variables: { activityId: entityId },
    entityId,
  });
  return log;
}

const renderIn = (node: React.ReactNode) =>
  render(<ThemeProvider scheme="light">{node}</ThemeProvider>);

beforeEach(() => {
  onlineManager.setOnline(true);
});

afterEach(() => {
  setActiveIntentLog(undefined);
  onlineManager.setOnline(true);
});

describe('OfflineBar', () => {
  it('renders nothing when online with an empty queue', () => {
    renderIn(<OfflineBar />);
    expect(screen.queryByTestId('offline-bar')).toBeNull();
  });

  it('states §5.4 copy exactly while offline', () => {
    onlineManager.setOnline(false);
    renderIn(<OfflineBar />);

    expect(screen.getByTestId('offline-bar').textContent).toBe(
      'Offline — changes will sync.',
    );
  });

  it('leaves the moment connectivity returns, even with the queue still draining', async () => {
    setActiveIntentLog(await logWithIntent());
    onlineManager.setOnline(false);
    const { rerender } = renderIn(<OfflineBar />);
    expect(screen.getByTestId('offline-bar')).not.toBeNull();

    /**
     * Back online with that write still queued. The bar answers "are you online", so it goes —
     * founder, 2026-08-17. The row's own `Pending` indicator is what keeps reporting the write.
     */
    onlineManager.setOnline(true);
    rerender(
      <ThemeProvider scheme="light">
        <OfflineBar />
      </ThemeProvider>,
    );

    expect(screen.queryByTestId('offline-bar')).toBeNull();
  });
});

describe('the blocked-intent banner', () => {
  it('names how many writes could not be applied', async () => {
    const log = await logWithIntent();
    await log.fail(`intent-${ACTIVITY}`, 'rejected');
    setActiveIntentLog(log);
    renderIn(
      <SafeAreaProvider>
        <SyncStatusBanner />
      </SafeAreaProvider>,
    );

    // Singular, because one write is one change and "1 changes" is a defect users notice.
    expect(screen.getByTestId('blocked-intents').textContent).toBe(
      "1 change couldn't be applied.",
    );
  });

  it('stays silent while the queue is merely waiting', async () => {
    setActiveIntentLog(await logWithIntent());
    renderIn(
      <SafeAreaProvider>
        <SyncStatusBanner />
      </SafeAreaProvider>,
    );

    expect(screen.queryByTestId('blocked-intents')).toBeNull();
  });
});

describe('PendingIndicator', () => {
  it('renders nothing for an entity with no queued work', async () => {
    setActiveIntentLog(await logWithIntent('act-other'));
    renderIn(<PendingIndicator entityId={ACTIVITY} />);

    expect(screen.queryByTestId('pending-indicator')).toBeNull();
  });

  it('marks the row its own intent belongs to', async () => {
    setActiveIntentLog(await logWithIntent());
    renderIn(<PendingIndicator entityId={ACTIVITY} />);

    expect(screen.getByTestId('pending-indicator').textContent).toBe('Pending');
  });

  it('takes its copy as a parameter, so Phase 3 is not a second system', async () => {
    setActiveIntentLog(await logWithIntent());
    renderIn(<PendingIndicator entityId={ACTIVITY} label="Plan will finish syncing" />);

    expect(screen.getByTestId('pending-indicator').textContent).toBe(
      'Plan will finish syncing',
    );
  });

  it('is entity-generic, so a reminder id works the same way', async () => {
    const reminder = 'rem_01J0000000000000000000000D';
    setActiveIntentLog(await logWithIntent(reminder));
    renderIn(<PendingIndicator entityId={reminder} />);

    expect(screen.getByTestId('pending-indicator').textContent).toBe('Pending');
  });
});
