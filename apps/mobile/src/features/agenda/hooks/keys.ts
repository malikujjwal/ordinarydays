import { ACTIVITIES_KEY } from '@/lib/queryKeys';

/** The pushed Anytime list is the saved `#N` activity stage. */
export const ANYTIME_KEY = [...ACTIVITIES_KEY, 'saved'] as const;

/** The complete Plans projection for one viewer timezone. */
export const plansProjectionKey = (timezone: string) =>
  ['plans', 'projection', timezone] as const;
