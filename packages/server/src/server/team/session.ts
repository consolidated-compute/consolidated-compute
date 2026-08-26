import type { SessionInboundMessage, SessionOutboundMessage } from "../messages.js";
import { TeamRpcErrorCodeSchema, type TeamRpcErrorCode } from "@getpaseo/protocol/team/rpc-schemas";
import { TeamExecutionPreflightError } from "./execution.js";
import type {
  CreateTeamDefinitionInput,
  ListTeamRunsInput,
  TeamDefinitionPatch,
  TeamRepository,
} from "./repository.js";
import { TeamNotFoundError, TeamRunNotFoundError, TeamStorageCorruptError } from "./repository.js";
import type { StartTeamRunInput, TeamRunService } from "./service.js";
import { toTeamDefinitionDto, toTeamRunDto } from "./wire.js";

export interface TeamSessionRepository {
  createDefinition(
    input: CreateTeamDefinitionInput,
  ): ReturnType<TeamRepository["createDefinition"]>;
  listDefinitions(): ReturnType<TeamRepository["listDefinitions"]>;
  getDefinition(teamId: string): ReturnType<TeamRepository["getDefinition"]>;
  updateDefinition(input: {
    teamId: string;
    expectedRevision: number;
    patch: TeamDefinitionPatch;
  }): ReturnType<TeamRepository["updateDefinition"]>;
  deleteDefinition(input: {
    teamId: string;
    expectedRevision: number;
  }): ReturnType<TeamRepository["deleteDefinition"]>;
  listRuns(input?: ListTeamRunsInput): ReturnType<TeamRepository["listRuns"]>;
  getRun(runId: string): ReturnType<TeamRepository["getRun"]>;
}

export interface TeamSessionRunService {
  startRun(input: StartTeamRunInput): ReturnType<TeamRunService["startRun"]>;
  cancelRun(runId: string): ReturnType<TeamRunService["cancelRun"]>;
}

export interface TeamSessionOptions {
  repository: TeamSessionRepository;
  runService: TeamSessionRunService;
  emit(message: SessionOutboundMessage): void;
}

interface TeamRpcError {
  code: TeamRpcErrorCode;
  message: string;
}

export class TeamSession {
  private readonly repository: TeamSessionRepository;
  private readonly runService: TeamSessionRunService;
  private readonly emit: TeamSessionOptions["emit"];

  constructor(options: TeamSessionOptions) {
    this.repository = options.repository;
    this.runService = options.runService;
    this.emit = options.emit;
  }

  dispatch(message: SessionInboundMessage): Promise<void> | undefined {
    switch (message.type) {
      case "team.create.request":
        return this.respond(message, async () => ({
          type: "team.create.response",
          payload: {
            requestId: message.requestId,
            team: toTeamDefinitionDto(await this.repository.createDefinition(message.definition)),
          },
        }));
      case "team.list.request":
        return this.respond(message, async () => {
          const result = await this.repository.listDefinitions();
          requireHealthyTeamCollection(result.issues);
          return {
            type: "team.list.response",
            payload: {
              requestId: message.requestId,
              teams: result.definitions.map(toTeamDefinitionDto),
            },
          };
        });
      case "team.get.request":
        return this.respond(message, async () => {
          const team = await this.repository.getDefinition(message.teamId);
          if (!team) throw new TeamNotFoundError(message.teamId);
          return {
            type: "team.get.response",
            payload: { requestId: message.requestId, team: toTeamDefinitionDto(team) },
          };
        });
      case "team.update.request":
        return this.respond(message, async () => ({
          type: "team.update.response",
          payload: {
            requestId: message.requestId,
            team: toTeamDefinitionDto(
              await this.repository.updateDefinition({
                teamId: message.teamId,
                expectedRevision: message.expectedRevision,
                patch: message.patch,
              }),
            ),
          },
        }));
      case "team.delete.request":
        return this.respond(message, async () => {
          await this.repository.deleteDefinition({
            teamId: message.teamId,
            expectedRevision: message.expectedRevision,
          });
          return {
            type: "team.delete.response",
            payload: {
              requestId: message.requestId,
              teamId: message.teamId,
              revision: message.expectedRevision,
            },
          };
        });
      case "team.run.start.request":
        return this.respond(message, async () => ({
          type: "team.run.start.response",
          payload: {
            requestId: message.requestId,
            run: toTeamRunDto(
              await this.runService.startRun({
                teamId: message.teamId,
                expectedRevision: message.expectedRevision,
                idempotencyKey: message.idempotencyKey,
                objective: message.objective,
                workspaceId: message.workspaceId,
              }),
            ),
          },
        }));
      case "team.run.list.request":
        return this.respond(message, async () => {
          const result = await this.repository.listRuns({
            ...(message.teamId !== undefined ? { teamId: message.teamId } : {}),
            ...(message.cursor !== undefined ? { cursor: message.cursor } : {}),
            ...(message.limit !== undefined ? { limit: message.limit } : {}),
          });
          requireHealthyTeamCollection(result.issues);
          return {
            type: "team.run.list.response",
            payload: {
              requestId: message.requestId,
              runs: result.runs.map(toTeamRunDto),
              nextCursor: result.nextCursor,
            },
          };
        });
      case "team.run.get.request":
        return this.respond(message, async () => {
          const run = await this.repository.getRun(message.runId);
          if (!run) throw new TeamRunNotFoundError(message.runId);
          return {
            type: "team.run.get.response",
            payload: { requestId: message.requestId, run: toTeamRunDto(run) },
          };
        });
      case "team.run.cancel.request":
        return this.respond(message, async () => ({
          type: "team.run.cancel.response",
          payload: {
            requestId: message.requestId,
            run: toTeamRunDto(await this.runService.cancelRun(message.runId)),
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
      const rpcError = toTeamRpcError(error);
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

function requireHealthyTeamCollection(issues: TeamStorageCorruptError["issues"]): void {
  const invalidRecords = issues.filter((issue) => issue.kind === "invalid_record");
  if (invalidRecords.length > 0) throw new TeamStorageCorruptError(invalidRecords);
}

function toTeamRpcError(error: unknown): TeamRpcError {
  if (error instanceof TeamExecutionPreflightError) {
    const issue = error.issues[0];
    if (issue?.kind === "profile_not_found") {
      return { code: "team_profile_not_found", message: error.message };
    }
    if (issue?.kind === "profile_ambiguous") {
      return { code: "team_profile_ambiguous", message: error.message };
    }
    if (issue?.kind === "profile_invalid") {
      return { code: "team_profile_invalid", message: error.message };
    }
    if (issue?.kind === "launch_unavailable") {
      return { code: "team_launch_unavailable", message: error.message };
    }
    if (
      issue?.kind === "workspace_not_found" ||
      issue?.kind === "workspace_archived" ||
      issue?.kind === "workspace_mismatch"
    ) {
      return { code: "team_workspace_unsupported", message: error.message };
    }
  }

  if (error instanceof Error) {
    const parsedCode = TeamRpcErrorCodeSchema.safeParse("code" in error ? error.code : undefined);
    const code = parsedCode.success ? parsedCode.data : null;
    return { code: code ?? "team_request_failed", message: error.message };
  }
  return { code: "team_request_failed", message: String(error) };
}
