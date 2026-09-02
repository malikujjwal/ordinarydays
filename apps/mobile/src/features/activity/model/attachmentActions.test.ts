import { instant } from '@od/shared/schemas';
import type { Attachment } from '@od/shared/types';
import { describe, expect, it } from 'vitest';
import {
  canManageAttachments,
  deleteAttachmentConfirmation,
  resolveHero,
} from './attachmentActions';

const OWNER = 'usr_01J0000000000000000000000B';
const OTHER = 'usr_01J0000000000000000000000C';

const attachment = (id: string): Attachment => ({
  attachmentId: id,
  activityId: 'act_01J8XKQ2M4N5P6R7S8T9V0W1X2',
  key: `u/${OWNER}/${id.slice(4)}.jpg`,
  contentType: 'image/jpeg',
  byteSize: 1024,
  createdAt: instant.parse('2026-09-01T00:00:00.000Z'),
  schemaVersion: 1,
});

describe('canManageAttachments', () => {
  it('is the owner, and only the owner', () => {
    expect(canManageAttachments({ ownerId: OWNER }, OWNER)).toBe(true);
    expect(canManageAttachments({ ownerId: OWNER }, OTHER)).toBe(false);
  });

  /** Absent rather than disabled for a participant — and for a viewer not yet identified. */
  it('treats an unknown viewer as not the owner', () => {
    expect(canManageAttachments({ ownerId: OWNER }, undefined)).toBe(false);
  });
});

describe('resolveHero', () => {
  const a = attachment('att_01J8XKQ2M4N5P6R7S8T9V0W1A1');
  const b = attachment('att_01J8XKQ2M4N5P6R7S8T9V0W1A2');

  it('is the attachment the cover id names', () => {
    expect(resolveHero(b.attachmentId, [a, b])).toBe(b);
  });

  it('is nothing without a cover id', () => {
    expect(resolveHero(undefined, [a, b])).toBeUndefined();
  });

  /** A deleted cover, not yet refetched: collapse, never a broken image. */
  it('is nothing when the id names no attachment the plan holds', () => {
    expect(resolveHero('att_01J8XKQ2M4N5P6R7S8T9V0W1A9', [a, b])).toBeUndefined();
  });
});

describe('deleteAttachmentConfirmation', () => {
  it('names the photo, repeats the verb and keeps the rest', () => {
    const confirmation = deleteAttachmentConfirmation({
      position: 2,
      total: 3,
      isCover: false,
    });
    expect(confirmation.heading).toBe('Delete photo 2 of 3?');
    expect(confirmation.confirmLabel).toBe('Delete photo');
    expect(confirmation.removes).toEqual(['Photo 2 of 3 will be removed']);
    expect(confirmation.keeps).toBe('Everything else on the plan stays.');
  });

  it('says when the photo is the cover, because that is what else disappears', () => {
    const confirmation = deleteAttachmentConfirmation({
      position: 1,
      total: 1,
      isCover: true,
    });
    expect(confirmation.removes).toContain(
      'It is the cover, so the plan will have none until you set another',
    );
    expect(
      confirmation.consequences?.some((c) => c.text === 'The cover is cleared'),
    ).toBe(true);
  });
});
