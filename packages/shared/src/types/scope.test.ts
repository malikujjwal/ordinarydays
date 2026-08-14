import { describe, expect, it } from 'vitest';
import {
  activityScope,
  occurrenceScope,
  scopeDate,
  scopeFromWire,
  scopeToWire,
  targetsWholeSeries,
} from './scope.js';

describe('ActivityScope', () => {
  it('round-trips through the wire form the API still speaks', () => {
    expect(scopeToWire(occurrenceScope('2026-08-13'))).toEqual({
      occurrenceDate: '2026-08-13',
    });
    expect(scopeFromWire({ occurrenceDate: '2026-08-13' })).toEqual(
      occurrenceScope('2026-08-13'),
    );
  });

  /**
   * Spreadable under `exactOptionalPropertyTypes`: an activity-scoped write must omit the key
   * rather than send `occurrenceDate: undefined`, which `strictObject` would reject.
   */
  it('omits the key entirely for an activity-scoped write', () => {
    expect(scopeToWire(activityScope())).toEqual({});
    expect('occurrenceDate' in scopeToWire(activityScope())).toBe(false);
  });

  it('reads an absent occurrence date as activity scope', () => {
    expect(scopeFromWire({})).toEqual(activityScope());
    expect(scopeFromWire({ occurrenceDate: undefined })).toEqual(activityScope());
  });

  it('exposes the date only when there is one', () => {
    expect(scopeDate(occurrenceScope('2026-08-13'))).toBe('2026-08-13');
    expect(scopeDate(activityScope())).toBeUndefined();
  });

  describe('targetsWholeSeries', () => {
    /** The condition every guard in the codebase was missing, stated once. */
    it('is true only for an activity-scoped write against something that recurs', () => {
      expect(targetsWholeSeries(true, activityScope())).toBe(true);
      expect(targetsWholeSeries(true, occurrenceScope('2026-08-13'))).toBe(false);
      expect(targetsWholeSeries(false, activityScope())).toBe(false);
      expect(targetsWholeSeries(false, occurrenceScope('2026-08-13'))).toBe(false);
    });
  });
});
