// @vitest-environment node
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Missing port');
  await new Promise<void>((done) => server.close(() => done()));
  return address.port;
}

/**
 * Windows has no POSIX signals: Node's `kill('SIGTERM')` there terminates the child outright,
 * so the proxy's `SIGTERM` handler — the graceful close this test exists to prove — never runs
 * and no clean exit code is ever reported. The Maestro stack runs on macOS.
 */
it.skipIf(process.platform === 'win32')(
  'terminates the proxy with an active held Plans request',
  async () => {
    const [proxyPort, controlPort] = await Promise.all([freePort(), freePort()]);
    const child = spawn(
      process.execPath,
      [resolve('../../e2e/mobile-network-proxy.mjs')],
      {
        env: {
          ...process.env,
          MAESTRO_PROXY_PORT: String(proxyPort),
          MAESTRO_CONTROL_PORT: String(controlPort),
        },
        stdio: 'ignore',
      },
    );
    const control = `http://127.0.0.1:${controlPort}`;
    let pending: Promise<unknown> | undefined;
    try {
      await expect
        .poll(async () => {
          try {
            return (await fetch(`${control}/stats`)).ok;
          } catch {
            return false;
          }
        })
        .toBe(true);
      await fetch(`${control}/hold-plans`, { method: 'POST' });
      pending = fetch(`http://127.0.0.1:${proxyPort}/v1/plans`).catch(() => undefined);
      await expect
        .poll(async () => (await (await fetch(`${control}/stats`)).json()).total)
        .toBe(1);
      child.kill('SIGTERM');
      await expect.poll(() => child.exitCode).toBe(0);
    } finally {
      child.kill('SIGKILL');
      await pending;
    }
  },
);
