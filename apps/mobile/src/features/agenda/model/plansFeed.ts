import { MAX_AGENDA_DAYS } from '@od/shared/constants';
import { describeApiFailure } from '@/lib/apiFailure';

/** What the web and native Plans hooks must agree on: the window size and the failure copy. */

/** One bounded window request spans at most `MAX_AGENDA_DAYS` inclusive dates. */
export const PLANS_WINDOW_DAYS = MAX_AGENDA_DAYS;

export const describePlansFailure = (error: unknown) =>
  describeApiFailure(error, "Couldn't load this.");
