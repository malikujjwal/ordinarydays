import { ChevronRight, Text, Touchable, useTheme } from '@od/ui';
import { type ReactNode, useState } from 'react';
import { View } from 'react-native';

export interface DetailDisclosureRowProps {
  title: string;
  summary: string;
  children?: ReactNode;
  testID: string;
}

/**
 * One capability on Activity detail.
 *
 * A real capability is a disclosure button: the summary remains readable while collapsed and
 * the chevron plus `accessibilityState.expanded` make its behaviour explicit. A capability
 * that belongs to a later phase has no children, so it renders as an ordinary, noninteractive
 * row reading `Coming later` rather than as a disabled control that pretends an action exists.
 */
export function DetailDisclosureRow({
  title,
  summary,
  children,
  testID,
}: DetailDisclosureRowProps) {
  const theme = useTheme();
  const [expanded, setExpanded] = useState(false);
  const expandable = children !== undefined;

  const content = (
    <View
      style={{
        minHeight: theme.layout.rowMinHeight,
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space[4],
      }}
    >
      <View style={{ flex: 1, gap: theme.space[1] }}>
        <Text variant="bodyStrong" color="textPrimary">
          {title}
        </Text>
        <Text variant="footnote" color="textSecondary">
          {summary}
        </Text>
      </View>
      {expandable ? (
        <View
          aria-hidden
          style={{ transform: [{ rotate: expanded ? '90deg' : '0deg' }] }}
        >
          <ChevronRight size={20} color={theme.colors.textSecondary} />
        </View>
      ) : (
        <Text variant="footnoteStrong" color="textSecondary">
          Coming later
        </Text>
      )}
    </View>
  );

  return (
    <View
      style={{ borderTopWidth: 1, borderTopColor: theme.colors.border }}
      testID={testID}
    >
      {expandable ? (
        <Touchable
          accessibilityRole="button"
          accessibilityLabel={`${title}, ${summary}`}
          accessibilityState={{ expanded }}
          aria-expanded={expanded}
          square={false}
          onPress={() => setExpanded((current) => !current)}
          testID={`${testID}-toggle`}
        >
          {content}
        </Touchable>
      ) : (
        <View accessibilityLabel={`${title}, coming later`}>{content}</View>
      )}

      {expanded ? (
        <View
          style={{ gap: theme.space[4], paddingBottom: theme.space[6] }}
          testID={`${testID}-content`}
        >
          {children}
        </View>
      ) : null}
    </View>
  );
}
