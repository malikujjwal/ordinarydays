import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

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
