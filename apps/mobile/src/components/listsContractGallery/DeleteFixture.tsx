import type { List } from '@od/shared/types';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { deleteListConfirmation } from '@/features/lists/model/deleteConfirmation';
import { preset } from './fixtures';
import { OpenListFixture } from './OpenListFixture';

/** Centred List-deletion consequence dialog over a populated List. */
export function DeleteFixture() {
  const list: List = {
    ...preset(1),
    title: 'Weekend packing',
    itemCount: 18,
    doneCount: 7,
    memberCount: 3,
  };

  return (
    <>
      <OpenListFixture state="checklist" />
      <ConfirmDialog
        open
        centred
        confirmation={deleteListConfirmation(list)}
        onCancel={() => {}}
        onConfirm={() => {}}
        testID="list-delete-confirm"
      />
    </>
  );
}
