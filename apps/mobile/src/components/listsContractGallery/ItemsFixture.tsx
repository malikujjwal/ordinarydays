import { ScreenShell, Text, useTheme } from '@od/ui';
import { View } from 'react-native';
import { ListItemRow } from '@/features/lists/components/ListItemRow';
import { Frame } from './Frame';
import { itemFixture, preset } from './fixtures';

/** Populated and empty typed-feature summaries in the common item shell. */
export function ItemsFixture() {
  const theme = useTheme();
  return (
    <ScreenShell measure="reading">
      <View style={{ gap: theme.space[6], paddingBottom: theme.space[10] }}>
        <Text variant="title">Typed item summaries</Text>
        <Frame title="Watch">
          <ListItemRow list={preset(3)} item={itemFixture(0)} onOpen={() => {}} />
        </Frame>
        <Frame title="Books">
          <ListItemRow list={preset(4)} item={itemFixture(1)} onOpen={() => {}} />
        </Frame>
        <Frame title="Places">
          <ListItemRow list={preset(5)} item={itemFixture(2)} onOpen={() => {}} />
        </Frame>
        <Frame title="Meals">
          <ListItemRow list={preset(6)} item={itemFixture(3)} onOpen={() => {}} />
        </Frame>
        <Frame title="Empty configured feature">
          <ListItemRow list={preset(5)} item={itemFixture(4)} onOpen={() => {}} />
        </Frame>
      </View>
    </ScreenShell>
  );
}
