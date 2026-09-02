import {
  AssignmentRpcErrorCodeSchema,
  type AssignmentRpcErrorCode,
} from "@getpaseo/protocol/assignment/rpc-schemas";

import type { SessionInboundMessage, SessionOutboundMessage } from "../messages.js";
import type {
  AdmitSupervisedAssignmentTeamRunInput,
  StartAssignmentTeamRunInput,
  TeamRunService,
} from "../team/service.js";
import { toTeamRpcError, type TeamRpcError } from "../team/session.js";
import { toTeamRunDto } from "../team/wire.js";
import type {
  AssignmentPatch,
  AssignmentRepository,
  ListAssignmentArtifactsInput,
} from "./repository.js";
import { AssignmentNotFoundError } from "./repository.js";
import {
  toAssignmentArtifactDto,
  toAssignmentCollectionIssueDto,
  toAssignmentDto,
} from "./wire.js";

export interface AssignmentSessionRepository {
  createAssignment(
    input: Parameters<AssignmentRepository["createAssignment"]>[0],
  ): ReturnType<AssignmentRepository["createAssignment"]>;
  listAssignments(): ReturnType<AssignmentRepository["listAssignments"]>;
  getAssignment(assignmentId: string): ReturnType<AssignmentRepository["getAssignment"]>;
  patchAssignment(input: {
    assignmentId: string;
    expectedRevision: number;
    patch: AssignmentPatch;
  }): ReturnType<AssignmentRepository["patchAssignment"]>;
  completeAssignment(input: {
    assignmentId: string;
    expectedRevision: number;
  }): ReturnType<AssignmentRepository["completeAssignment"]>;
  cancelAssignment(input: {
    assignmentId: string;
    expectedRevision: number;
  }): ReturnType<AssignmentRepository["cancelAssignment"]>;
  getArtifact(artifactId: string): ReturnType<AssignmentRepository["getArtifact"]>;
  listArtifacts(
    input: ListAssignmentArtifactsInput,
  ): ReturnType<AssignmentRepository["listArtifacts"]>;
}

export interface AssignmentSessionRunService {
  startAssignmentRun(
    input: StartAssignmentTeamRunInput,
  ): ReturnType<TeamRunService["startAssignmentRun"]>;
  admitSupervisedAssignmentRun(
    input: AdmitSupervisedAssignmentTeamRunInput,
  ): ReturnType<TeamRunService["admitSupervisedAssignmentRun"]>;
}

export interface AssignmentSessionOptions {
  repository: AssignmentSessionRepository;
  runService: AssignmentSessionRunService;
  emit(message: SessionOutboundMessage): void;
}

class AssignmentArtifactNotFoundError extends Error {
  readonly code = "assignment_artifact_not_found";

  constructor(artifactId: string) {
    super(`Assignment Artifact not found: ${artifactId}`);
    this.name = "AssignmentArtifactNotFoundError";
  }
}

interface AssignmentRpcError {
  code: AssignmentRpcErrorCode | TeamRpcError["code"];
  message: string;
}

export class AssignmentSession {
  private readonly repository: AssignmentSessionRepository;
  private readonly runService: AssignmentSessionRunService;
  private readonly emit: AssignmentSessionOptions["emit"];

  constructor(options: AssignmentSessionOptions) {
    this.repository = options.repository;
    this.runService = options.runService;
    this.emit = options.emit;
  }

  dispatch(message: SessionInboundMessage): Promise<void> | undefined {
    switch (message.type) {
      case "assignment.create.request":
        return this.respond(message, async () => ({
          type: "assignment.create.response",
          payload: {
            requestId: message.requestId,
            assignment: toAssignmentDto(await this.repository.createAssignment(message.assignment)),
          },
        }));
      case "assignment.list.request":
        return this.respond(message, async () => {
          const result = await this.repository.listAssignments();
          return {
            type: "assignment.list.response",
            payload: {
              requestId: message.requestId,
              assignments: result.assignments.map(toAssignmentDto),
              issues: result.issues.map(toAssignmentCollectionIssueDto),
            },
          };
        });
      case "assignment.get.request":
        return this.respond(message, async () => {
          const assignment = await this.repository.getAssignment(message.assignmentId);
          if (!assignment) throw new AssignmentNotFoundError(message.assignmentId);
          return {
            type: "assignment.get.response",
            payload: { requestId: message.requestId, assignment: toAssignmentDto(assignment) },
          };
        });
      case "assignment.patch.request":
        return this.respond(message, async () => ({
          type: "assignment.patch.response",
          payload: {
            requestId: message.requestId,
            assignment: toAssignmentDto(
              await this.repository.patchAssignment({
                assignmentId: message.assignmentId,
                expectedRevision: message.expectedRevision,
                patch: message.patch,
              }),
            ),
          },
        }));
      case "assignment.complete.request":
        return this.respond(message, async () => ({
          type: "assignment.complete.response",
          payload: {
            requestId: message.requestId,
            assignment: toAssignmentDto(
              await this.repository.completeAssignment({
                assignmentId: message.assignmentId,
                expectedRevision: message.expectedRevision,
              }),
            ),
          },
        }));
      case "assignment.cancel.request":
        return this.respond(message, async () => ({
          type: "assignment.cancel.response",
          payload: {
            requestId: message.requestId,
            assignment: toAssignmentDto(
              await this.repository.cancelAssignment({
                assignmentId: message.assignmentId,
                expectedRevision: message.expectedRevision,
              }),
            ),
          },
        }));
      case "assignment.artifact.get.request":
        return this.respond(message, async () => {
          const artifact = await this.repository.getArtifact(message.artifactId);
          if (!artifact) throw new AssignmentArtifactNotFoundError(message.artifactId);
          return {
            type: "assignment.artifact.get.response",
            payload: { requestId: message.requestId, artifact: toAssignmentArtifactDto(artifact) },
          };
        });
      case "assignment.artifact.list.request":
        return this.respond(message, async () => {
          const result = await this.repository.listArtifacts({
            assignmentId: message.assignmentId,
            ...(message.cursor !== undefined ? { cursor: message.cursor } : {}),
            ...(message.limit !== undefined ? { limit: message.limit } : {}),
          });
          return {
            type: "assignment.artifact.list.response",
            payload: {
              requestId: message.requestId,
              artifacts: result.artifacts.map(toAssignmentArtifactDto),
              nextCursor: result.nextCursor,
              issues: result.issues.map(toAssignmentCollectionIssueDto),
            },
          };
        });
      case "assignment.team_run.start.request":
        return this.respond(message, async () => ({
          type: "assignment.team_run.start.response",
          payload: {
            requestId: message.requestId,
            run: toTeamRunDto(
              await (message.supervision
                ? this.runService.admitSupervisedAssignmentRun({
                    teamId: message.teamId,
                    expectedRevision: message.expectedRevision,
                    idempotencyKey: message.idempotencyKey,
                    assignmentId: message.assignmentId,
                    expectedAssignmentRevision: message.expectedAssignmentRevision,
                    workspaceId: message.workspaceId,
                    supervisorRoleId: message.supervision.supervisorRoleId,
                    ...(message.expectedPreviewFingerprint !== undefined
                      ? { expectedPreviewFingerprint: message.expectedPreviewFingerprint }
                      : {}),
                  })
                : this.runService.startAssignmentRun({
                    teamId: message.teamId,
                    expectedRevision: message.expectedRevision,
                    idempotencyKey: message.idempotencyKey,
                    assignmentId: message.assignmentId,
                    expectedAssignmentRevision: message.expectedAssignmentRevision,
                    workspaceId: message.workspaceId,
                    ...(message.expectedPreviewFingerprint !== undefined
                      ? { expectedPreviewFingerprint: message.expectedPreviewFingerprint }
                      : {}),
                  })),
            ),
          },
        }));
      default:
        return undefined;
    }
  }

  private async respond(
    request: SessionInboundMessage & { requestId: string },
    operation: () => Promise<SessionOutboundMessage>,
  ): Promise<void> {
    try {
      this.emit(await operation());
    } catch (error) {
      const rpcError = toAssignmentRpcError(error);
      this.emit({
        type: "rpc_error",
        payload: {
          requestId: request.requestId,
          requestType: request.type,
          error: rpcError.message,
          code: rpcError.code,
        },
      });
    }
  }
}

function toAssignmentRpcError(error: unknown): AssignmentRpcError {
  if (error instanceof Error) {
    const parsedCode = AssignmentRpcErrorCodeSchema.safeParse(
      "code" in error ? error.code : undefined,
    );
    if (parsedCode.success) return { code: parsedCode.data, message: error.message };
  }
  const teamError = toTeamRpcError(error);
  if (teamError.code !== "team_request_failed") return teamError;
  return {
    code: "assignment_request_failed",
    message: error instanceof Error ? error.message : String(error),
  };
}
