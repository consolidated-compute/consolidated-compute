import type {
  AssignmentArtifactDto,
  AssignmentCollectionIssueDto,
  AssignmentDto,
  AssignmentInputDto,
  AssignmentPatchDto,
} from "@getpaseo/protocol/assignment/types";
import type { TeamRunDto } from "@getpaseo/protocol/team/types";
import { connectDaemonClient } from "./daemon-client-loader";

export interface AssignmentsDaemonClient {
  connect(): Promise<void>;
  close(): Promise<void>;
  createAssignment(input: AssignmentInputDto): Promise<{ assignment: AssignmentDto }>;
  listAssignments(): Promise<{
    assignments: AssignmentDto[];
    issues?: AssignmentCollectionIssueDto[];
  }>;
  getAssignment(assignmentId: string): Promise<{ assignment: AssignmentDto }>;
  patchAssignment(input: {
    assignmentId: string;
    expectedRevision: number;
    patch: AssignmentPatchDto;
  }): Promise<{ assignment: AssignmentDto }>;
  completeAssignment(input: {
    assignmentId: string;
    expectedRevision: number;
  }): Promise<{ assignment: AssignmentDto }>;
  listAssignmentArtifacts(input: {
    assignmentId: string;
    cursor?: string;
    limit?: number;
  }): Promise<{
    artifacts: AssignmentArtifactDto[];
    nextCursor: string | null;
    issues?: AssignmentCollectionIssueDto[];
  }>;
  getTeamRun(runId: string): Promise<{ run: TeamRunDto }>;
}

export function connectAssignmentsClient(options?: {
  port?: number;
}): Promise<AssignmentsDaemonClient> {
  return connectDaemonClient<AssignmentsDaemonClient>({
    clientIdPrefix: "assignments-e2e",
    port: options?.port,
  });
}
