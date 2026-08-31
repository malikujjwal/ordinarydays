import { NewListSheet } from '@/features/lists/components/NewListSheet';
import { DeleteFixture } from './DeleteFixture';
import { GlobalComposerFixture } from './GlobalComposerFixture';
import { IndexChromeFixture } from './IndexChromeFixture';
import { ItemDetailsFixture } from './ItemDetailsFixture';
import { ItemStatePlaceFixture } from './ItemStatePlaceFixture';
import { ItemsFixture } from './ItemsFixture';
import { ListHeaderMenuFixture } from './ListHeaderMenuFixture';
import { ListIndexMenuFixture } from './ListIndexMenuFixture';
import { OpenListFixture } from './OpenListFixture';
import { OverviewFixture } from './OverviewFixture';
import { SettingsFixture } from './SettingsFixture';

export interface ContractFrameProps {
  frame: string;
}

/** Maps a gallery frame name to one deterministic production-component fixture. */
export function ContractFrame({ frame }: ContractFrameProps) {
  if (frame === 'index-chrome') return <IndexChromeFixture state="populated" />;
  if (frame === 'index-chrome-empty') return <IndexChromeFixture state="empty" />;
  if (frame === 'index-chrome-loading') return <IndexChromeFixture state="loading" />;
  if (frame === 'settings') return <SettingsFixture />;
  if (frame === 'create') return <NewListSheet open onClose={() => {}} />;
  if (frame === 'items') return <ItemsFixture />;
  if (frame === 'stages') return <OpenListFixture state="stages" />;
  if (frame === 'empty') return <OpenListFixture state="empty" />;
  if (frame === 'checklist') return <OpenListFixture state="checklist" />;
  if (frame === 'context-add') return <OpenListFixture state="context-add" />;
  if (frame === 'context-add-long') return <OpenListFixture state="context-add-long" />;
  if (frame === 'short-header') return <OpenListFixture state="short-header" />;
  if (frame === 'long-header') return <OpenListFixture state="long-header" />;
  if (frame === 'global-add') return <GlobalComposerFixture />;
  if (frame === 'item-details') return <ItemDetailsFixture />;
  if (frame === 'item-state-place') return <ItemStatePlaceFixture />;
  if (frame === 'index-menu') return <ListIndexMenuFixture />;
  if (frame === 'detail-menu') return <ListHeaderMenuFixture checked />;
  if (frame === 'detail-menu-empty') return <ListHeaderMenuFixture checked={false} />;
  if (frame === 'delete') return <DeleteFixture />;
  return <OverviewFixture />;
}
