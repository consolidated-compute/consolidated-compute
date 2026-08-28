import { z } from "zod";

import {
  TeamDefinitionDtoSchema,
  TeamDefinitionInputDtoSchema,
  TeamDefinitionPatchDtoSchema,
  TeamRunDtoSchema,
  TeamRunPreviewDtoSchema,
  TeamRunPreviewFingerprintSchema,
} from "./types.js";

export const TEAM_RUN_PAGE_MAX_LIMIT = 100;

export const TEAM_RPC_ERROR_CODES = [
  "teams_unsupported",
  "team_not_found",
  "team_run_not_found",
  "team_revision_conflict",
  "team_has_active_run",
  "team_workspace_has_active_run",
  "team_assignment_has_active_run",
  "team_run_idempotency_conflict",
  "invalid_team_run_page",
  "invalid_team_repository_id",
  "team_storage_corrupt",
  "team_run_service_shutting_down",
  "team_execution_preflight_failed",
  "team_security_preview_stale",
  "team_profile_not_found",
  "team_profile_ambiguous",
  "team_profile_invalid",
  "team_launch_unavailable",
  "team_workspace_unsupported",
  "team_request_failed",
] as const;

export const TeamRpcErrorCodeSchema = z.enum(TEAM_RPC_ERROR_CODES);
export type TeamRpcErrorCode = z.infer<typeof TeamRpcErrorCodeSchema>;

export const TeamCreateRequestSchema = z.object({
  type: z.literal("team.create.request"),
  requestId: z.string(),
  definition: TeamDefinitionInputDtoSchema,
});

export const TeamListRequestSchema = z.object({
  type: z.literal("team.list.request"),
  requestId: z.string(),
});

export const TeamGetRequestSchema = z.object({
  type: z.literal("team.get.request"),
  requestId: z.string(),
  teamId: z.string(),
});

export const TeamUpdateRequestSchema = z.object({
  type: z.literal("team.update.request"),
  requestId: z.string(),
  teamId: z.string(),
  expectedRevision: z.number().int().positive(),
  patch: TeamDefinitionPatchDtoSchema,
});

export const TeamDeleteRequestSchema = z.object({
  type: z.literal("team.delete.request"),
  requestId: z.string(),
  teamId: z.string(),
  expectedRevision: z.number().int().positive(),
});

export const TeamRunStartRequestSchema = z.object({
  type: z.literal("team.run.start.request"),
  requestId: z.string(),
  teamId: z.string(),
  expectedRevision: z.number().int().positive(),
  idempotencyKey: z.string(),
  objective: z.string(),
  workspaceId: z.string(),
  expectedPreviewFingerprint: TeamRunPreviewFingerprintSchema.optional(),
});

export const TeamRunPreviewRequestSchema = z.object({
  type: z.literal("team.run.preview.request"),
  requestId: z.string(),
  teamId: z.string(),
  expectedRevision: z.number().int().positive(),
  workspaceId: z.string(),
});

export const TeamRunListRequestSchema = z.object({
  type: z.literal("team.run.list.request"),
  requestId: z.string(),
  teamId: z.string().optional(),
  cursor: z.string().optional(),
  limit: z.number().int().positive().max(TEAM_RUN_PAGE_MAX_LIMIT).optional(),
});

export const TeamRunGetRequestSchema = z.object({
  type: z.literal("team.run.get.request"),
  requestId: z.string(),
  runId: z.string(),
});

export const TeamRunCancelRequestSchema = z.object({
  type: z.literal("team.run.cancel.request"),
  requestId: z.string(),
  runId: z.string(),
});

export const TeamCreateResponseSchema = z.object({
  type: z.literal("team.create.response"),
  payload: z.object({ requestId: z.string(), team: TeamDefinitionDtoSchema }),
});

export const TeamListResponseSchema = z.object({
  type: z.literal("team.list.response"),
  payload: z.object({ requestId: z.string(), teams: z.array(TeamDefinitionDtoSchema) }),
});

export const TeamGetResponseSchema = z.object({
  type: z.literal("team.get.response"),
  payload: z.object({ requestId: z.string(), team: TeamDefinitionDtoSchema }),
});

export const TeamUpdateResponseSchema = z.object({
  type: z.literal("team.update.response"),
  payload: z.object({ requestId: z.string(), team: TeamDefinitionDtoSchema }),
});

export const TeamDeleteResponseSchema = z.object({
  type: z.literal("team.delete.response"),
  payload: z.object({ requestId: z.string(), teamId: z.string(), revision: z.number().int() }),
});

export const TeamRunStartResponseSchema = z.object({
  type: z.literal("team.run.start.response"),
  payload: z.object({ requestId: z.string(), run: TeamRunDtoSchema }),
});

export const TeamRunPreviewResponseSchema = z.object({
  type: z.literal("team.run.preview.response"),
  payload: z.object({ requestId: z.string(), preview: TeamRunPreviewDtoSchema }),
});

export const TeamRunListResponseSchema = z.object({
  type: z.literal("team.run.list.response"),
  payload: z.object({
    requestId: z.string(),
    runs: z.array(TeamRunDtoSchema),
    nextCursor: z.string().nullable(),
  }),
});

export const TeamRunGetResponseSchema = z.object({
  type: z.literal("team.run.get.response"),
  payload: z.object({ requestId: z.string(), run: TeamRunDtoSchema }),
});

export const TeamRunCancelResponseSchema = z.object({
  type: z.literal("team.run.cancel.response"),
  payload: z.object({ requestId: z.string(), run: TeamRunDtoSchema }),
});

export type TeamCreateRequest = z.infer<typeof TeamCreateRequestSchema>;
export type TeamListRequest = z.infer<typeof TeamListRequestSchema>;
export type TeamGetRequest = z.infer<typeof TeamGetRequestSchema>;
export type TeamUpdateRequest = z.infer<typeof TeamUpdateRequestSchema>;
export type TeamDeleteRequest = z.infer<typeof TeamDeleteRequestSchema>;
export type TeamRunStartRequest = z.infer<typeof TeamRunStartRequestSchema>;
export type TeamRunPreviewRequest = z.infer<typeof TeamRunPreviewRequestSchema>;
export type TeamRunListRequest = z.infer<typeof TeamRunListRequestSchema>;
export type TeamRunGetRequest = z.infer<typeof TeamRunGetRequestSchema>;
export type TeamRunCancelRequest = z.infer<typeof TeamRunCancelRequestSchema>;
