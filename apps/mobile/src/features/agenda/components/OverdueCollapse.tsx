import { Text, Touchable, useTheme } from '@od/ui';

export interface OverdueCollapseProps {
  hiddenCount: number;
  expanded: boolean;
  onToggle: () => void;
}

/** The inline, local-only expander for Today's rolled-forward overdue group. */
export function OverdueCollapse({
  hiddenCount,
  expanded,
  onToggle,
}: OverdueCollapseProps) {
  const theme = useTheme();

  return (
    <Touchable
      accessibilityRole="button"
      accessibilityLabel={`${hiddenCount} more overdue`}
      accessibilityState={{ expanded }}
      aria-expanded={expanded}
      onPress={onToggle}
      testID="today-overdue-collapse"
      style={{
        paddingHorizontal: theme.space[8],
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.border,
      }}
    >
      <Text variant="footnoteStrong" color="textSecondary">
        {expanded ? 'Show fewer overdue' : `+${hiddenCount} more overdue`}
      </Text>
    </Touchable>
  );
}
