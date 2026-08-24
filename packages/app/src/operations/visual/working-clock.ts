import { useLayoutEffect } from "react";
import {
  cancelAnimation,
  Easing,
  type SharedValue,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";
import type { VisualNode } from "./topology";
import { shouldRunVisualWorkingClock } from "./presentation";

export function useVisualWorkingClock(nodes: readonly VisualNode[]): {
  phase: SharedValue<number>;
  isActive: boolean;
} {
  const reduceMotion = useReducedMotion();
  const phase = useSharedValue(0);
  const active = shouldRunVisualWorkingClock({
    nodes,
    isFocused: true,
    reduceMotion,
  });

  useLayoutEffect(() => {
    cancelAnimation(phase);
    phase.value = 0;
    if (!active) return;

    phase.value = withRepeat(
      withTiming(1, {
        duration: 900,
        easing: Easing.inOut(Easing.ease),
      }),
      -1,
      true,
    );
    return () => {
      cancelAnimation(phase);
      phase.value = 0;
    };
  }, [active, phase]);

  return { phase, isActive: active };
}
