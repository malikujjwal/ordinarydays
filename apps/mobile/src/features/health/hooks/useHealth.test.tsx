import { ApiError } from '@od/shared/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { Text } from 'react-native';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useHealth } from '@/features/health/hooks/useHealth';

/**
 * The first hook test in the app, and the pattern every later one copies.
 *
 * It renders a real component through a real `QueryClientProvider` rather than calling the
 * hook in isolation: `useHealth` exists to turn TanStack Query's several failure shapes into
 * the one `HealthView` a screen renders, and the interesting cases — a paused query with a
 * failure behind it — only exist inside the library's state machine.
 *
 * `getHealth` is stubbed at the module boundary, which is the seam `tech-stack.md` §3.2
 * draws: a hook calls the shared client, and the shared client is the only thing that knows
 * the wire is HTTP. Stubbing `fetch` instead would be testing the transport twice.
 */
vi.mock('@od/shared/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@od/shared/client')>()),
  getHealth: vi.fn(),
}));

const { getHealth } = await import('@od/shared/client');
const getHealthMock = vi.mocked(getHealth);

/** A client with retries off, so an error case resolves in one tick rather than four. */
function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, networkMode: 'always' } },
  });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

/** Renders the hook's output as text, so assertions are by what a user would perceive. */
function Probe() {
  const health = useHealth();
  return (
    <>
      <Text testID="status">{health.status}</Text>
      <Text testID="baseUrl">{health.baseUrl}</Text>
      <Text testID="stage">{health.data?.stage ?? '—'}</Text>
      <Text testID="message">{health.message ?? '—'}</Text>
      <Text testID="requestId">{health.requestId ?? '—'}</Text>
    </>
  );
}

const at = (testId: string) => screen.getByTestId(testId).textContent;

beforeEach(() => {
  getHealthMock.mockReset();
});

describe('useHealth', () => {
  it('reports the base URL before any request has been made', () => {
    getHealthMock.mockReturnValue(new Promise(() => {}));
    render(<Probe />, { wrapper });

    // The important one on a physical device: "the app is calling localhost, which on a
    // phone is the phone" has to be visible even while the request is in flight.
    expect(at('baseUrl')).toBe('http://localhost:3000');
    expect(at('status')).toBe('pending');
  });

  it('surfaces the stage on success', async () => {
    getHealthMock.mockResolvedValue({
      status: 'ok',
      sha: 'abc1234',
      stage: 'local',
      coldStart: true,
    });

    render(<Probe />, { wrapper });

    await waitFor(() => expect(at('status')).toBe('success'));
    expect(at('stage')).toBe('local');
  });

  /**
   * A 5xx must not put the server's words on the screen. `interaction-contract.md` §5.3
   * says the copy is ours; the `requestId` is what makes the failure traceable instead.
   */
  it('replaces a 5xx message with the contract copy but keeps the requestId', async () => {
    getHealthMock.mockRejectedValue(
      new ApiError('internal', 'Table od-main-local throttled', 500, 'req_abc'),
    );

    render(<Probe />, { wrapper });

    await waitFor(() => expect(at('status')).toBe('error'));
    expect(at('message')).toBe('Something went wrong.');
    expect(at('message')).not.toContain('od-main-local');
    expect(at('requestId')).toBe('req_abc');
  });

  it('shows a 4xx message as sent, because it is written for the user', async () => {
    getHealthMock.mockRejectedValue(
      new ApiError('not_found', 'Not found.', 404, 'req_def'),
    );

    render(<Probe />, { wrapper });

    await waitFor(() => expect(at('status')).toBe('error'));
    expect(at('message')).toBe('Not found.');
  });

  /**
   * A transport failure is not an `ApiError` and has no requestId. The message must still be
   * the contract's, never `Failed to fetch` — which describes a socket, not a situation.
   */
  it('describes a non-envelope failure in the contract copy', async () => {
    getHealthMock.mockRejectedValue(new TypeError('Failed to fetch'));

    render(<Probe />, { wrapper });

    await waitFor(() => expect(at('status')).toBe('error'));
    expect(at('message')).toBe("Couldn't load this.");
    expect(at('requestId')).toBe('—');
  });
});
