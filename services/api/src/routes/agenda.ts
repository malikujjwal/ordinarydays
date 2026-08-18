import { zValidator } from '@hono/zod-validator';
import { agendaQuery, ulidId } from '@od/shared/schemas';
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../app-env.js';
import {
  GET_ACTIVITY_AGENDA_PATH,
  getActivityAgendaHandler,
} from '../handlers/getActivityAgenda.js';
import { GET_AGENDA_PATH, getAgendaHandler } from '../handlers/getAgenda.js';

const validateAgendaQuery = zValidator('query', agendaQuery, (result) => {
  if (!result.success) throw result.error;
});
const validateActivityParams = zValidator(
  'param',
  z.strictObject({ id: ulidId('act') }),
  (result) => {
    if (!result.success) throw result.error;
  },
);

/** `GET /v1/agenda`, the one read that supplies a complete Today window. */
export const agenda = new Hono<AppEnv>()
  .get(GET_AGENDA_PATH, validateAgendaQuery, (c) =>
    getAgendaHandler(c, c.req.valid('query'), new Date().toISOString()),
  )
  .get(GET_ACTIVITY_AGENDA_PATH, validateActivityParams, validateAgendaQuery, (c) =>
    getActivityAgendaHandler(c, c.req.valid('query'), new Date().toISOString()),
  );
