import type {
  AssignmentArtifactDto,
  AssignmentCollectionIssueDto,
} from "@getpaseo/protocol/assignment/types";

export const assignmentArtifactsQueryBaseKey = ["assignmentArtifacts"] as const;

export interface AssignmentArtifactPage {
  artifacts: AssignmentArtifactDto[];
  nextCursor: string | null;
  issues: AssignmentCollectionIssueDto[];
}

export function assignmentArtifactListQueryKey(
  serverId: string,
  assignmentId: string,
  teamRunId?: string,
) {
  if (teamRunId) {
    return [
      ...assignmentArtifactsQueryBaseKey,
      serverId,
      assignmentId,
      "run",
      teamRunId,
      "list",
    ] as const;
  }
  return [...assignmentArtifactsQueryBaseKey, serverId, assignmentId, "list"] as const;
}

export function flattenAssignmentArtifactPages(
  pages: readonly AssignmentArtifactPage[],
): AssignmentArtifactDto[] {
  const seen = new Set<string>();
  return pages.flatMap((page) =>
    page.artifacts.filter((artifact) => {
      if (seen.has(artifact.id)) return false;
      seen.add(artifact.id);
      return true;
    }),
  );
}

export function assignmentArtifactIssues(
  pages: readonly AssignmentArtifactPage[],
): AssignmentCollectionIssueDto[] {
  const seen = new Set<string>();
  return pages.flatMap((page) =>
    page.issues.filter((issue) => {
      const key = JSON.stringify([issue.collection, issue.fileName, issue.kind, issue.message]);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }),
  );
}

export function artifactsForRun(
  artifacts: readonly AssignmentArtifactDto[],
  teamRunId: string,
): AssignmentArtifactDto[] {
  return artifacts.filter((artifact) => artifact.producer.teamRunId === teamRunId);
}

export async function loadNextTeamRunArtifactPage(input: {
  teamRunId: string;
  cursor: string | null;
  loadPage: (cursor: string | null) => Promise<AssignmentArtifactPage>;
}): Promise<AssignmentArtifactPage> {
  const scannedPages: AssignmentArtifactPage[] = [];
  let cursor = input.cursor;
  while (true) {
    const page = await input.loadPage(cursor);
    scannedPages.push(page);
    const artifacts = artifactsForRun(page.artifacts, input.teamRunId);
    if (artifacts.length > 0 || page.nextCursor === null) {
      return {
        artifacts,
        nextCursor: page.nextCursor,
        issues: assignmentArtifactIssues(scannedPages),
      };
    }
    cursor = page.nextCursor;
  }
}
