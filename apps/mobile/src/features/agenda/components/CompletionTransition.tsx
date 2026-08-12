import { useMotion } from '@od/ui';
import type { ReactNode } from 'react';
import { useEffect } from 'react';
import Animated, {
  cancelAnimation,
  Easing,
  ReduceMotion,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withTiming,
} from 'react-native-reanimated';

export interface CompletionTransitionProps {
  children: ReactNode;
  transitionKey: string;
  onFinished: (transitionKey: string) => void;
}

/** Briefly acknowledges completion in place before Today reveals its new section. */
export function CompletionTransition({
  children,
  transitionKey,
  onFinished,
}: CompletionTransitionProps) {
  const motion = useMotion();
  const opacity = useSharedValue(1);

  useEffect(() => {
    opacity.value = withDelay(
      motion.duration.fast,
      withTiming(
        0,
        {
          duration: motion.duration.base,
          easing: Easing.bezier(0.3, 0, 1, 1),
          reduceMotion: ReduceMotion.System,
        },
        (finished) => {
          if (finished) runOnJS(onFinished)(transitionKey);
        },
      ),
      ReduceMotion.System,
    );
    return () => cancelAnimation(opacity);
  }, [motion.duration.base, motion.duration.fast, onFinished, opacity, transitionKey]);

  const animatedStyle = useAnimatedStyle(() => ({ opacity: opacity.value }));

  return (
    <Animated.View style={animatedStyle} testID="completion-transition-row">
      {children}
    </Animated.View>
  );
}
