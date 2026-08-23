import { RecurrenceValidationError } from '@od/shared/recurrence';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { AppEnv } from '../app-env.js';
import { INTERNAL_ERROR_MESSAGE } from '../lib/errors.js';
import { ListReadFenceError } from '../repositories/listRepository.js';
import { errorHandler } from './errorHandler.js';

function appThrowing(error: Error): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.onError(errorHandler);
  app.use('*', async (c, next) => {
    c.set('requestId', 'req_error_handler');
    c.set('routeAuth', 'authenticated');
    await next();
  });
  app.get('/probe', () => {
    throw error;
  });
  return app;
}

describe('errorHandler classification', () => {
  it('maps recurrence validation failures to the public validation contract', async () => {
    const response = await appThrowing(
      new RecurrenceValidationError('Weekly recurrence requires weekdays.'),
    ).request('/probe');

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: 'validation_failed',
        message: 'Weekly recurrence requires weekdays.',
        requestId: 'req_error_handler',
      },
    });
  });

  it.each(['ProvisionedThroughputExceededException', 'RequestLimitExceeded'])(
    'maps %s to a retryable 503 without leaking its message',
    async (name) => {
      const error = new Error('table/key detail that must stay private');
      error.name = name;

      const response = await appThrowing(error).request('/probe');

      expect(response.status).toBe(503);
      expect(response.headers.get('Retry-After')).toBe('1');
      await expect(response.json()).resolves.toMatchObject({
        error: { code: 'internal', message: INTERNAL_ERROR_MESSAGE },
      });
    },
  );

  it('maps a list read-fence failure to the retryable internal contract', async () => {
    const response = await appThrowing(new ListReadFenceError()).request('/probe');

    expect(response.status).toBe(503);
    expect(response.headers.get('Retry-After')).toBe('1');
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'internal', message: INTERNAL_ERROR_MESSAGE },
    });
  });
});
