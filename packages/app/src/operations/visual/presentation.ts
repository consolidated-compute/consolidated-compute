import type { WorkspaceStateBucket } from "@getpaseo/protocol/agent-state-bucket";
import type { VisualRelationshipKind } from "./topology";

export type VisualStateEmphasis = "urgent" | "critical" | "active" | "notice" | "quiet";

export interface VisualStatePresentation {
  icon: WorkspaceStateBucket;
  emphasis: VisualStateEmphasis;
  canAnimate: boolean;
  isMuted: boolean;
}

export function resolveVisualStatePresentation({
  state,
  isLastKnown,
}: {
  state: WorkspaceStateBucket;
  isLastKnown: boolean;
}): VisualStatePresentation {
  if (isLastKnown) {
    return { icon: state, emphasis: "quiet", canAnimate: false, isMuted: true };
  }

  switch (state) {
    case "needs_input":
      return { icon: state, emphasis: "urgent", canAnimate: false, isMuted: false };
    case "failed":
      return { icon: state, emphasis: "critical", canAnimate: false, isMuted: false };
    case "running":
      return { icon: state, emphasis: "active", canAnimate: true, isMuted: false };
    case "attention":
      return { icon: state, emphasis: "notice", canAnimate: false, isMuted: false };
    case "done":
      return { icon: state, emphasis: "quiet", canAnimate: false, isMuted: false };
  }
}

export function shouldRunVisualWorkingClock({
  nodes,
  isFocused,
  reduceMotion,
}: {
  nodes: readonly Pick<
    { state: WorkspaceStateBucket; isLastKnown: boolean },
    "state" | "isLastKnown"
  >[];
  isFocused: boolean;
  reduceMotion: boolean;
}): boolean {
  return (
    isFocused &&
    !reduceMotion &&
    nodes.some((node) => resolveVisualStatePresentation(node).canAnimate)
  );
}

export type VisualRelationshipIcon = VisualRelationshipKind;

export type VisualRelationshipLabelKey =
  | "visual.relationship.nested"
  | "visual.relationship.provider"
  | "operations.relationship.crossWorkspace"
  | "operations.relationship.missing"
  | "operations.relationship.cycle";

export interface VisualRelationshipPresentation {
  icon: VisualRelationshipIcon;
  labelKey: VisualRelationshipLabelKey;
}

export function resolveVisualRelationshipPresentation(
  kind: VisualRelationshipKind,
): VisualRelationshipPresentation {
  switch (kind) {
    case "nested":
      return { icon: kind, labelKey: "visual.relationship.nested" };
    case "provider":
      return { icon: kind, labelKey: "visual.relationship.provider" };
    case "cross_workspace":
      return { icon: kind, labelKey: "operations.relationship.crossWorkspace" };
    case "missing":
      return { icon: kind, labelKey: "operations.relationship.missing" };
    case "cycle":
      return { icon: kind, labelKey: "operations.relationship.cycle" };
  }
}
