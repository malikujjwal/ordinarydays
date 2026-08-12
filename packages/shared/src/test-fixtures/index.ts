import capturedResponse from '../fixtures/workedExampleDay.response.json' with {
  type: 'json',
};
import type { AgendaData } from '../types/index.js';

export const WORKED_EXAMPLE_DATE = '2026-08-06';
export const WORKED_EXAMPLE_TIMEZONE = 'America/New_York';
export const WORKED_EXAMPLE_NOW = '2026-08-06T19:10:00.000Z';
export const WORKED_EXAMPLE_USER_ID = 'usr_worked_example';

export const WORKED_EXAMPLE_ACTIVITY_IDS = {
  oats: 'act_01J8XKQ2M4N5P6R7S8T9V0W1A1',
  dentist: 'act_01J8XKQ2M4N5P6R7S8T9V0W1A2',
  groceries: 'act_01J8XKQ2M4N5P6R7S8T9V0W1A3',
  gym: 'act_01J8XKQ2M4N5P6R7S8T9V0W1A4',
  tacos: 'act_01J8XKQ2M4N5P6R7S8T9V0W1A5',
  severance: 'act_01J8XKQ2M4N5P6R7S8T9V0W1A6',
  insurance: 'act_01J8XKQ2M4N5P6R7S8T9V0W1A7',
  apartment: 'act_01J8XKQ2M4N5P6R7S8T9V0W1A8',
  flights: 'act_01J8XKQ2M4N5P6R7S8T9V0W1A9',
  parentPlan: 'act_01J8XKQ2M4N5P6R7S8T9V0W1AP',
} as const;

/** A fresh copy for every consumer; no test can mutate another test's fixture. */
export function workedExampleDayResponse(): AgendaData {
  return structuredClone(capturedResponse) as AgendaData;
}
