import { ThemeProvider } from '@od/ui';
import { onlineManager } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { act } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PendingIndicator } from '@/components/PendingIndicator';
import { SyncStatusBanner } from '@/features/shell/components/SyncStatusBanner';
import { IntentLog, type IntentLogStorage } from '@/lib/intentLog';
import { setActiveIntentLog } from '@/lib/intentReplay';
import { ConnectivityStatus } from './ConnectivityStatus';

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

async function logWithIntents(count = 1, mutation = 'create'): Promise<IntentLog> {
  const log = new IntentLog(USER, memoryStorage());
  await log.hydrate();
  for (let index = 0; index < count; index += 1) {
    await log.append({
      intentId: `intent-${index}`,
      mutationKey: ['activity', mutation],
      variables: { activityId: `${ACTIVITY}-${index}` },
      entityId: `${ACTIVITY}-${index}`,
    });
  }
  return log;
}

const renderIn = (node: React.ReactNode) =>
  render(<ThemeProvider scheme="light">{node}</ThemeProvider>);

beforeEach(() => {
  onlineManager.setOnline(true);
});

afterEach(() => {
  vi.useRealTimers();
  setActiveIntentLog(undefined);
  onlineManager.setOnline(true);
});

describe('ConnectivityStatus', () => {
  it('renders nothing during ordinary online use', () => {
    renderIn(<ConnectivityStatus />);
    expect(screen.queryByTestId('connectivity-status')).toBeNull();
  });

  it('shows Offline without claiming there are writes when the queue is empty', () => {
    onlineManager.setOnline(false);
    renderIn(<ConnectivityStatus />);

    expect(screen.getByTestId('connectivity-status').textContent).toBe('Offline');
  });

  it('counts only replayable writes while offline', async () => {
    const log = await logWithIntents(3);
    setActiveIntentLog(log);
    onlineManager.setOnline(false);
    renderIn(<ConnectivityStatus />);

    expect(screen.getByTestId('connectivity-status').textContent).toBe('3 waiting');
    expect(screen.getByTestId('connectivity-status').getAttribute('aria-label')).toBe(
      '3 changes waiting to sync',
    );
  });

  it('changes to Syncing when connectivity returns and work remains', async () => {
    setActiveIntentLog(await logWithIntents());
    onlineManager.setOnline(false);
    renderIn(<ConnectivityStatus />);
    expect(screen.getByTestId('connectivity-status').textContent).toBe('1 waiting');
    expect(screen.getByTestId('connectivity-status').getAttribute('aria-label')).toBe(
      '1 change waiting to sync',
    );

    act(() => onlineManager.setOnline(true));

    expect(screen.getByTestId('connectivity-status').textContent).toBe('Syncing…');
  });

  it('briefly confirms success after the last write lands, then becomes quiet', async () => {
    vi.useFakeTimers();
    const log = await logWithIntents();
    setActiveIntentLog(log);
    renderIn(<ConnectivityStatus />);
    expect(screen.getByTestId('connectivity-status').textContent).toBe('Syncing…');

    await act(async () => {
      await log.acknowledge('intent-0');
    });

    expect(screen.getByTestId('connectivity-status').textContent).toBe('Synced');
    act(() => vi.advanceTimersByTime(2_000));
    expect(screen.queryByTestId('connectivity-status')).toBeNull();
  });

  it('does not call a rejected write synced', async () => {
    const log = await logWithIntents();
    setActiveIntentLog(log);
    renderIn(<ConnectivityStatus />);
    expect(screen.getByTestId('connectivity-status').textContent).toBe('Syncing…');

    await act(async () => {
      await log.fail('intent-0', 'rejected');
    });

    expect(screen.queryByTestId('connectivity-status')).toBeNull();
  });
});

describe('the blocked-intent banner', () => {
  it('names how many writes could not be applied', async () => {
    const log = await logWithIntents();
    await log.fail('intent-0', 'rejected');
    setActiveIntentLog(log);
    renderIn(
      <SafeAreaProvider>
        <SyncStatusBanner />
      </SafeAreaProvider>,
    );

    expect(screen.getByText("1 change couldn't be applied.")).toBeDefined();
  });

  it('stays silent while the queue is merely waiting', async () => {
    setActiveIntentLog(await logWithIntents());
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
    setActiveIntentLog(await logWithIntents());
    renderIn(<PendingIndicator entityId={ACTIVITY} />);

    expect(screen.queryByTestId('pending-indicator')).toBeNull();
  });

  it('marks the row its own intent belongs to', async () => {
    setActiveIntentLog(await logWithIntents());
    renderIn(<PendingIndicator entityId={`${ACTIVITY}-0`} />);

    expect(screen.getByTestId('pending-indicator').textContent).toBe('Pending');
  });

  it('takes its copy as a parameter, so Phase 3 is not a second system', async () => {
    setActiveIntentLog(await logWithIntents());
    renderIn(
      <PendingIndicator entityId={`${ACTIVITY}-0`} label="Plan will finish syncing" />,
    );

    expect(screen.getByTestId('pending-indicator').textContent).toBe(
      'Plan will finish syncing',
    );
  });

  it('stays out of the way when only a completion is queued', async () => {
    setActiveIntentLog(await logWithIntents(1, 'complete'));
    renderIn(<PendingIndicator entityId={`${ACTIVITY}-0`} />);

    expect(screen.queryByTestId('pending-indicator')).toBeNull();
  });

  it('is entity-generic, so a reminder id works the same way', async () => {
    const reminder = 'rem_01J0000000000000000000000D';
    const log = new IntentLog(USER, memoryStorage());
    await log.hydrate();
    await log.append({
      intentId: 'intent-reminder',
      mutationKey: ['activity', 'create'],
      variables: { activityId: reminder },
      entityId: reminder,
    });
    setActiveIntentLog(log);
    renderIn(<PendingIndicator entityId={reminder} />);

    expect(screen.getByTestId('pending-indicator').textContent).toBe('Pending');
  });
});
