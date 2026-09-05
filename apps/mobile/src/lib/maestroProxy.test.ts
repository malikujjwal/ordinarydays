import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { expect, it, vi } from 'vitest';

function proxyHarness() {
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
      return { listen: () => {} };
    },
    request: vi.fn(() => ({ on: () => {} })),
  };
  runInNewContext(
    readFileSync(resolve('../../e2e/mobile-network-proxy.mjs'), 'utf8').replace(
      "import http from 'node:http';",
      '',
    ),
    {
      http,
      URL,
      console: { log: () => {} },
      setTimeout,
      clearTimeout,
      process: { on: () => {} },
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
  return { send, forwarded: http.request };
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
