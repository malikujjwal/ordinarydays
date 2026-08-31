import { ListHeaderMenu } from '@/features/lists/components/ListHeaderMenu';
import { preset } from './fixtures';
import { OpenListFixture } from './OpenListFixture';

export interface ListHeaderMenuFixtureProps {
  checked: boolean;
}

/** Compact open-List menu with optional checked-item actions. */
export function ListHeaderMenuFixture({ checked }: ListHeaderMenuFixtureProps) {
  const list = { ...preset(1), title: 'Weekend packing', itemCount: 14, doneCount: 4 };
  return (
    <>
      <OpenListFixture state="checklist" />
      <ListHeaderMenu
        open
        onClose={() => {}}
        list={list}
        checkedCount={checked ? 4 : 0}
        onClearDone={() => {}}
        onUncheckAll={() => {}}
        onArchive={() => {}}
        onDelete={() => {}}
        onOpenSettings={() => {}}
      />
    </>
  );
}
