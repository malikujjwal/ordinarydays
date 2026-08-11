import { describe, expect, it } from 'vitest';
import { GSI1_PROJECTED_ATTRIBUTES, TABLE, tableName } from './definition.js';

/**
 * A GSI projection cannot be altered in place — changing it means replacing the index. So
 * the properties that would be expensive to get wrong are asserted here, where the cost of
 * finding out is a failing test rather than a migration.
 */

describe('TABLE', () => {
  it('keys on pk/sk with a ttl attribute', () => {
    expect(TABLE.partitionKey).toBe('pk');
    expect(TABLE.sortKey).toBe('sk');
    expect(TABLE.ttlAttribute).toBe('ttl');
  });

  it('declares exactly one index — every extra index is a second write on every mutation', () => {
    expect(TABLE.indexes).toHaveLength(1);
    expect(TABLE.indexes[0]?.name).toBe('GSI1');
  });

  it('projects INCLUDE, never ALL', () => {
    expect(TABLE.indexes[0]?.projection).toBe('INCLUDE');
  });

  it('does not repeat key attributes in nonKeyAttributes, which DynamoDB rejects', () => {
    const keys = [
      TABLE.partitionKey,
      TABLE.sortKey,
      TABLE.indexes[0]?.partitionKey,
      TABLE.indexes[0]?.sortKey,
    ];
    for (const key of keys) {
      expect(GSI1_PROJECTED_ATTRIBUTES as readonly string[]).not.toContain(key);
    }
  });

  it('projects no attribute twice', () => {
    const unique = new Set<string>(GSI1_PROJECTED_ATTRIBUTES);
    expect(unique.size).toBe(GSI1_PROJECTED_ATTRIBUTES.length);
  });

  it('projects the stored timezone for mixed-generation agenda reads', () => {
    expect(GSI1_PROJECTED_ATTRIBUTES).toContain('timezone');
  });

  it('omits the AgendaItem fields that are computed at read time', () => {
    // Projecting these would mean storing a value that goes stale: they depend on
    // occurrence expansion or on the caller's today, not on the row.
    for (const derived of [
      'occurrenceDate',
      'isSnoozed',
      'hasCheckbox',
      'isPast',
      'overdueFromDate',
    ]) {
      expect(GSI1_PROJECTED_ATTRIBUTES as readonly string[]).not.toContain(derived);
    }
  });
});

describe('tableName', () => {
  it.each([
    ['local', 'od-main-local'],
    ['dev', 'od-main-dev'],
    ['prod', 'od-main-prod'],
  ])('maps %s to %s', (stage, expected) => {
    expect(tableName(stage)).toBe(expected);
  });
});
