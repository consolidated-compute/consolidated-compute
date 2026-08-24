import { describe, expect, it } from "vitest";
import { fitVisualRectToWidth, resolveVisualLayoutMode } from "./viewport";

describe("resolveVisualLayoutMode", () => {
  it("uses vertical compact reflow until two columns remain legible", () => {
    expect(resolveVisualLayoutMode(0)).toBe("compact");
    expect(resolveVisualLayoutMode(899)).toBe("compact");
    expect(resolveVisualLayoutMode(900)).toBe("wide");
  });
});

describe("fitVisualRectToWidth", () => {
  it("uses the full measured width without scaling vertical geometry", () => {
    expect(
      fitVisualRectToWidth(
        { x: 10, y: 20, width: 50, height: 60 },
        { sceneWidth: 100, viewportWidth: 200 },
      ),
    ).toEqual({ x: 20, y: 20, width: 100, height: 60 });
  });

  it("keeps logical geometry before a usable measurement exists", () => {
    expect(
      fitVisualRectToWidth(
        { x: 10, y: 20, width: 50, height: 60 },
        { sceneWidth: 100, viewportWidth: 0 },
      ),
    ).toEqual({ x: 10, y: 20, width: 50, height: 60 });
  });
});
