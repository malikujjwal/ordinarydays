import { ThemeProvider } from '@od/ui';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cancelPendingCreate } from '@/hooks/usePendingIntents';
import { IntentLog, type IntentLogStorage } from '@/lib/intentLog';
import { setActiveIntentLog } from '@/lib/intentReplay';
import { PendingNotice } from './PendingNotice';

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

async function logWithCreate(): Promise<IntentLog> {
  const log = new IntentLog(USER, memoryStorage());
  await log.hydrate();
  await log.append({
    intentId: 'create-intent',
    mutationKey: ['activity', 'create'],
    variables: { input: { activityId: ACTIVITY, title: 'Written offline' } },
    entityId: ACTIVITY,
  });
  return log;
}

const renderIn = (node: React.ReactNode) =>
  render(<ThemeProvider scheme="light">{node}</ThemeProvider>);

afterEach(() => setActiveIntentLog(undefined));

describe('PendingNotice', () => {
  it('announces the explanation rather than relying on styling', () => {
    const message = 'Waiting to sync — you can cancel it.';
    renderIn(<PendingNotice message={message} onCancel={() => undefined} />);

    const notice = screen.getByTestId('pending-notice');
    /**
     * §6.4: a disabled control is never the only signal. The words carry the meaning, they
     * are announced when they appear, and they are reachable as one element — none of which
     * a colour or an opacity can do.
     */
    expect(notice.getAttribute('aria-live')).toBe('polite');
    expect(notice.getAttribute('aria-label')).toBe(message);
    expect(notice.textContent).toContain(message);
  });

  it('offers cancel only when one is given, so in flight shows none', () => {
    renderIn(
      <PendingNotice message="Syncing now — everything else unlocks once it’s synced." />,
    );

    // No cancel: a request already on the wire cannot be retracted.
    expect(screen.queryByTestId('pending-cancel')).toBeNull();
    expect(screen.getByTestId('pending-notice').textContent).toContain('Syncing now');
  });

  it('takes its copy as a parameter, so later phases are not second systems', () => {
    renderIn(<PendingNotice message="Plan will finish syncing." />);

    expect(screen.getByTestId('pending-notice').textContent).toContain(
      'Plan will finish syncing.',
    );
  });

  it('invokes cancel when the offered control is used', () => {
    const onCancel = vi.fn();
    renderIn(<PendingNotice message="Waiting to sync." onCancel={onCancel} />);

    fireEvent.click(screen.getByTestId('pending-cancel'));

    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});

describe('cancelling a queued create', () => {
  it('removes the intent and issues no request', async () => {
    const log = await logWithCreate();
    setActiveIntentLog(log);

    expect(await cancelPendingCreate('create-intent')).toBe(true);

    /**
     * Nothing reaches the network because there is nothing to retract: the create never left
     * the device. The intent is simply gone, and with it the row it was projecting.
     */
    expect(log.pending()).toHaveLength(0);
    expect(log.pendingCreateFor(ACTIVITY)).toBeUndefined();
  });

  it('refuses once the create is in flight', async () => {
    const log = await logWithCreate();
    await log.tryClaim('create-intent');
    setActiveIntentLog(log);

    expect(await cancelPendingCreate('create-intent')).toBe(false);
    // Still queued work, still pending — the request is out and cannot be recalled.
    expect(log.pendingCreateFor(ACTIVITY)?.status).toBe('in_flight');
  });

  it('distinguishes a pending create from a pending completion', async () => {
    const log = new IntentLog(USER, memoryStorage());
    await log.hydrate();
    await log.append({
      intentId: 'completion',
      mutationKey: ['activity', 'complete'],
      variables: { activityId: ACTIVITY },
      entityId: ACTIVITY,
    });

    /**
     * An activity the server already knows, with a queued completion, is **not** pending in
     * §5.4's sense: it exists, so every action still works. Conflating the two would freeze a
     * row every time a checkbox was ticked offline.
     */
    expect(log.pendingFor(ACTIVITY)).toHaveLength(1);
    expect(log.pendingCreateFor(ACTIVITY)).toBeUndefined();
  });
});
