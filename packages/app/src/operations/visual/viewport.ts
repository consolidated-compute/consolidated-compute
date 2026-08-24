import type { VisualLayoutMode, VisualRect } from "./topology";

export const VISUAL_WIDE_MIN_WIDTH = 900;

export function resolveVisualLayoutMode(viewportWidth: number): VisualLayoutMode {
  return viewportWidth >= VISUAL_WIDE_MIN_WIDTH ? "wide" : "compact";
}

export function fitVisualRectToWidth(
  rect: VisualRect,
  input: { sceneWidth: number; viewportWidth: number },
): VisualRect {
  const scale =
    input.sceneWidth > 0 && input.viewportWidth > 0 ? input.viewportWidth / input.sceneWidth : 1;
  return {
    x: rect.x * scale,
    y: rect.y,
    width: rect.width * scale,
    height: rect.height,
  };
}
