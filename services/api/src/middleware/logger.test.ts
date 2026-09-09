import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const lines = vi.hoisted(() => ({ records: [] as Record<string, unknown>[] }));

vi.mock('../lib/logger.js', () => ({
  logger: {
    child: (bindings: Record<string, unknown>) => ({
      info: (line: Record<string, unknown>) =>
        lines.records.push({ level: 'info', ...bindings, ...line }),
      warn: (line: Record<string, unknown>) =>
        lines.records.push({ level: 'warn', ...bindings, ...line }),
      error: (line: Record<string, unknown>) =>
        lines.records.push({ level: 'error', ...bindings, ...line }),
    }),
  },
}));

describe('requestLogger', () => {
  beforeEach(() => {
    lines.records = [];
  });

  it('records route and coldStart on the completion line', async () => {
    vi.resetModules();
    lines.records = [];
    const { requestLogger } = await import('./logger.js');
    const app = new Hono();
    app.use('*', async (c, next) => {
      c.set('requestId', 'req_log_1');
      c.set('userId', 'usr_local_dev');
      await next();
    });
    app.use('*', requestLogger);
    app.get('/v1/lists/:id', (c) => {
      c.header('X-Unused', '1');
      return c.json({ ok: true });
    });

    const first = await app.request('/v1/lists/lst_01J8XKQ2M4N5P6R7S8T9V0W1X2');
    const second = await app.request('/v1/lists/lst_01J8XKQ2M4N5P6R7S8T9V0W1X2');

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(lines.records).toEqual([
      expect.objectContaining({
        level: 'info',
        route: 'GET /v1/lists/:id',
        status: 200,
        coldStart: true,
        userId: 'usr_local_dev',
      }),
      expect.objectContaining({
        level: 'info',
        route: 'GET /v1/lists/:id',
        status: 200,
        coldStart: false,
        userId: 'usr_local_dev',
      }),
    ]);
    expect(lines.records[0]).toHaveProperty('durationMs');
    expect(lines.records[0]).toHaveProperty('requestId');
  });
});
