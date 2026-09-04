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
