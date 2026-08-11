import { describe, expect, it } from 'vitest';
import { scheduleActivityInput } from './schedule.js';

describe('scheduleActivityInput', () => {
  it.each([
    { date: '2026-08-12', timezone: 'America/New_York' },
    { date: '2026-08-12', time: '18:00', endTime: '19:00', timezone: 'UTC' },
    { date: null },
    { date: '2026-08-12', occurrenceDate: '2026-08-10' },
  ])('accepts the sole schedule body %#', (body) => {
    expect(scheduleActivityInput.safeParse(body).success).toBe(true);
  });

  it.each([
    { date: null, time: '18:00' },
    { date: '2026-08-12', endTime: '19:00' },
    { date: '2026-08-12', time: '19:00', endTime: '18:00' },
    { date: '2026-08-12', time: '19:00', endTime: '19:00' },
    { date: '2026-08-12', timezone: 'not a zone' },
    { date: '2026-08-12', status: 'scheduled' },
    { date: '2026-08-12', fromSuggestionId: 'sugg_1' },
  ])('rejects invalid or foreign body %#', (body) => {
    expect(scheduleActivityInput.safeParse(body).success).toBe(false);
  });
});
