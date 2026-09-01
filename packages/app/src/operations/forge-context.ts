import { getForgePresentation } from "@/git/forge";
import { selectPrHintFromStatus, type PrHint } from "@/git/pr-hint";
import { mapCheckStatus } from "@/git/pull-request-panel/check-status";
import { summarizeChecks, type ChecksOutcome } from "@/git/pull-request-panel/checks-summary";
import type { PrPaneCheck } from "@/git/pull-request-panel/data";
import type { WorkspaceSummary } from "@/utils/projects";

export type OperationsChangeRequestState = PrHint["state"] | "unknown";
export type OperationsChecksStatus = ChecksOutcome | "unknown";
export type OperationsReviewDecision =
  | Exclude<NonNullable<PrHint["reviewDecision"]>, null>
  | "unknown";

export interface OperationsChangeRequest {
  forge: string;
  number: number;
  url: string;
  state: OperationsChangeRequestState;
  checksStatus: OperationsChecksStatus;
  reviewDecision: OperationsReviewDecision;
}

export type OperationsForgeContext =
  | { kind: "unknown" }
  | { kind: "none" }
  | { kind: "change_request"; changeRequest: OperationsChangeRequest };

function selectChecksStatus(hint: PrHint): OperationsChecksStatus {
  if (hint.checks) {
    const checks: PrPaneCheck[] = hint.checks.map((check) => ({
      provider: hint.forge,
      name: check.name,
      status: mapCheckStatus(check.status),
      traits: check.traits,
      url: check.url ?? "",
    }));
    return summarizeChecks(checks).outcome;
  }
  return hint.checksStatus ?? "unknown";
}

function selectReviewDecision(hint: PrHint): OperationsReviewDecision {
  return hint.reviewDecision ?? "unknown";
}

export function selectOperationsForgeContext(input: {
  workspace: Pick<WorkspaceSummary, "forge" | "forgeRuntime">;
  isLastKnown: boolean;
}): OperationsForgeContext {
  const runtime = input.workspace.forgeRuntime;
  if (!runtime || runtime.error) return { kind: "unknown" };
  if (runtime.pullRequest === undefined) return { kind: "unknown" };
  if (runtime.pullRequest === null) {
    return input.isLastKnown ? { kind: "unknown" } : { kind: "none" };
  }

  const hint = selectPrHintFromStatus(runtime.pullRequest, input.workspace.forge);
  if (!hint) return { kind: "unknown" };

  return {
    kind: "change_request",
    changeRequest: {
      forge: hint.forge,
      number: hint.number,
      url: hint.url,
      state: input.isLastKnown ? "unknown" : hint.state,
      checksStatus: input.isLastKnown ? "unknown" : selectChecksStatus(hint),
      reviewDecision: input.isLastKnown ? "unknown" : selectReviewDecision(hint),
    },
  };
}

export function formatOperationsChangeRequestLabel(
  changeRequest: Pick<OperationsChangeRequest, "forge" | "number">,
): string {
  const presentation = getForgePresentation(changeRequest.forge);
  return `${presentation.changeRequestAbbrev} ${presentation.numberPrefix}${changeRequest.number}`;
}
