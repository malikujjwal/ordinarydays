import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

function runProxyScript(script: string, networkMode = 'proxy'): string[] {
  const requests: string[] = [];
  runInNewContext(readFileSync(resolve('e2e/scripts', script), 'utf8'), {
    API_BASE_URL: 'http://127.0.0.1:3000',
    PROXY_CONTROL_URL: 'http://127.0.0.1:8474',
    NETWORK_MODE: networkMode,
    FLOW: 'add-and-complete',
    output: {},
    http: {
      post(url: string, options?: { body?: string }) {
        // Match Maestro's HTTP boundary: POST requires an explicit request body.
        if (typeof options?.body !== 'string') {
          throw new Error('method POST must have a request body.');
        }
        requests.push(new URL(url).pathname);
        return { body: '{}' };
      },
    },
  });
  return requests;
}

describe('Maestro network-control scripts', () => {
  it.each([
    ['setup.js', ['/online', '/reset']],
    ['cleanup.js', ['/online']],
    ['proxy-offline.js', ['/reset', '/offline']],
    ['proxy-online.js', ['/online']],
  ] as const)('%s sends valid proxy requests', (script, paths) => {
    expect(runProxyScript(script)).toEqual(paths);
  });

  it.each(['proxy-offline.js', 'proxy-online.js'])(
    '%s leaves physical-device networking alone',
    (script) => {
      expect(runProxyScript(script, 'physical')).toEqual([]);
    },
  );
});

describe('Maestro fixture creation', () => {
  it.each(['2026-09-04T23:30:00.000Z', '2026-09-04T23:30:59.460Z'])(
    'keeps the initial ticker fixture eligible across the setup minute boundary (%s)',
    (instant) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(instant));
      const schedules: { date: string; time: string }[] = [];
      const output: { advanceAfterEpoch?: number } = {};
      try {
        runInNewContext(readFileSync(resolve('e2e/scripts/setup.js'), 'utf8'), {
          Date,
          API_BASE_URL: 'http://127.0.0.1:3000',
          PROXY_CONTROL_URL: 'http://127.0.0.1:8474',
          FLOW: 'up-next-ticker',
          output,
          http: {
            post(url: string, options: { body: string }) {
              if (new URL(url).pathname === '/v1/activities') {
                schedules.push(JSON.parse(options.body).schedule);
                return {
                  body: JSON.stringify({
                    data: { activityId: `ticker-${schedules.length}` },
                  }),
                };
              }
              return { body: '{}' };
            },
          },
        });
        expect(schedules.map(({ date, time }) => ({ date, time }))).toEqual([
          { date: '2026-09-04', time: '19:31' },
          { date: '2026-09-04', time: '19:32' },
        ]);
        expect(output.advanceAfterEpoch).toBe(Date.parse('2026-09-04T23:32:01Z'));
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it.each([
    ['offline-queue-relaunch', 3],
    ['source-list-reconciliation', 2],
    ['recurring-past-history', 2],
  ] as const)('uses distinct UUID keys for %s fixture writes', (flow, count) => {
    const keys: string[] = [];
    let seed = 1;
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-04T16:00:00Z'));
    try {
      runInNewContext(readFileSync(resolve('e2e/scripts/setup.js'), 'utf8'), {
        Date,
        Math: {
          floor: Math.floor,
          random: () => {
            seed = (seed * 16807) % 2147483647;
            return seed / 2147483647;
          },
        },
        API_BASE_URL: 'http://127.0.0.1:3000',
        PROXY_CONTROL_URL: 'http://127.0.0.1:8474',
        FLOW: flow,
        output: {},
        http: {
          post(url: string, options: { headers?: Record<string, string>; body: string }) {
            if (new URL(url).pathname.startsWith('/v1/')) {
              const key = options.headers?.['Idempotency-Key'];
              expect(key).toMatch(
                /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
              );
              if (key !== undefined) keys.push(key);
              return {
                body: JSON.stringify({
                  data: {
                    activityId: `fixture-${keys.length}`,
                    listId: `list-${keys.length}`,
                  },
                }),
              };
            }
            return { body: '{}' };
          },
        },
      });
      expect(keys).toHaveLength(count);
      expect(new Set(keys).size).toBe(count);
    } finally {
      vi.useRealTimers();
    }
  });
});

it('retains the durable offline-created Activity ID for exact cleanup', () => {
  const output = { title: 'Unique task', today: '2026-09-05', activityIds: ['seed'] };
  const get = vi.fn((_url: string) => ({
    body: JSON.stringify({ activityId: 'created' }),
  }));
  runInNewContext(
    readFileSync(resolve('e2e/scripts/assert-created-persisted.js'), 'utf8'),
    {
      PROXY_CONTROL_URL: 'http://127.0.0.1:18474',
      output,
      http: { get },
    },
  );
  expect(new URL(get.mock.calls[0]?.[0] ?? '').searchParams.get('title')).toBe(
    'Unique task',
  );
  expect(output.activityIds).toEqual(['seed', 'created']);
});

it('cleans up a submitted offline create even when the journey failed before reconnect verification', () => {
  const deleted: string[] = [];
  runInNewContext(readFileSync(resolve('e2e/scripts/cleanup.js'), 'utf8'), {
    API_BASE_URL: 'http://127.0.0.1:13000',
    PROXY_CONTROL_URL: 'http://127.0.0.1:18474',
    output: {
      title: 'Owned offline task',
      today: '2026-09-05',
      offlineCreateSubmitted: true,
    },
    http: {
      post: () => ({ body: '{}' }),
      get: (url: string) => ({
        body: JSON.stringify(
          url.includes('/wait-for-activity')
            ? { activityId: 'late-create' }
            : { data: { days: [] } },
        ),
      }),
      delete: (url: string) => {
        deleted.push(url);
      },
    },
  });
  expect(deleted).toEqual(['http://127.0.0.1:13000/v1/activities/late-create']);
});
