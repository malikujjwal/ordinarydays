import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { expect, it, vi } from 'vitest';

function proxyHarness(env: Record<string, string> = {}, fetcher = vi.fn()) {
  const listeners: unknown[] = [];
  type Request = {
    url: string;
    method: string;
    headers: { host: string };
    pipe: () => void;
  };
  type Response = { writeHead: () => void; end: (body: string) => void };
  const handlers: ((request: Request, response: Response) => void)[] = [];
  const http = {
    createServer(handler: (request: Request, response: Response) => void) {
      handlers.push(handler);
      return {
        listen: (...args: unknown[]) => {
          listeners.push(args.slice(0, 2));
        },
      };
    },
    request: vi.fn((_url: URL, ..._args: unknown[]) => ({ on: () => {} })),
  };
  runInNewContext(
    readFileSync(resolve('../../e2e/mobile-network-proxy.mjs'), 'utf8').replace(
      "import http from 'node:http';",
      '',
    ),
    {
      http,
      URL,
      URLSearchParams,
      Date,
      AbortSignal,
      fetch: fetcher,
      console: { log: () => {} },
      setTimeout,
      clearTimeout,
      process: { on: () => {}, env },
    },
  );
  const send = (server: number, url: string, method = 'GET') => {
    let body = '';
    handlers[server]?.(
      { url, method, headers: { host: 'localhost' }, pipe: () => {} },
      {
        writeHead: () => {},
        end: (value) => {
          body = value;
        },
      },
    );
    return body;
  };
  const sendAsync = (url: string) =>
    new Promise<string>((done) => {
      handlers[1]?.(
        { url, method: 'GET', headers: { host: 'localhost' }, pipe: () => {} },
        { writeHead: () => {}, end: done },
      );
    });
  return { send, sendAsync, forwarded: http.request, listeners };
}

it('records only Plans date bounds so native journeys can prove bounded loading', () => {
  const { send } = proxyHarness();
  send(
    0,
    '/v1/plans?mode=upcoming_window&upcomingFrom=2027-09-01&upcomingTo=2027-09-30&secret=omit',
  );
  const stats = send(1, '/stats');
  expect(JSON.parse(stats).plansRequests).toEqual([
    { mode: 'upcoming_window', from: '2027-09-01', through: '2027-09-30' },
  ]);
  expect(stats).not.toContain('secret');
});

it('holds a Plans request until the journey explicitly releases it', () => {
  const { send, forwarded } = proxyHarness();
  send(1, '/hold-plans', 'POST');
  send(0, '/v1/plans?mode=upcoming_window&upcomingFrom=2027-09-01&upcomingTo=2027-09-30');
  expect(forwarded).not.toHaveBeenCalled();
  send(1, '/release-plans', 'POST');
  expect(forwarded).toHaveBeenCalledTimes(1);
});

it('isolates native test proxy ports and upstream from the development stack', () => {
  const { send, forwarded, listeners } = proxyHarness({
    MAESTRO_PROXY_PORT: '13000',
    MAESTRO_CONTROL_PORT: '18474',
    MAESTRO_API_URL: 'http://127.0.0.1:13001',
  });
  expect(listeners).toEqual([
    [13000, '0.0.0.0'],
    [18474, '0.0.0.0'],
  ]);
  send(0, '/v1/health');
  expect(forwarded.mock.calls[0]?.[0].toString()).toBe(
    'http://127.0.0.1:13001/v1/health',
  );
});

it('waits for the exact offline-created Activity to persist before allowing cleanup', async () => {
  vi.useFakeTimers();
  try {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: { days: [] } }) })
      .mockResolvedValue({
        ok: true,
        json: async () => ({
          data: {
            days: [
              {
                anytime: [
                  { activityId: 'unrelated', title: 'Another task' },
                  { activityId: 'created', title: 'Unique offline task' },
                ],
              },
            ],
          },
        }),
      });
    const { sendAsync } = proxyHarness({}, fetcher);
    const result = sendAsync(
      '/wait-for-activity?date=2026-09-05&title=Unique%20offline%20task',
    );
    await vi.advanceTimersByTimeAsync(100);
    expect(JSON.parse(await result)).toEqual({ activityId: 'created' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  } finally {
    vi.useRealTimers();
  }
});
