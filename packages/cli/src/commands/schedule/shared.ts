import { connectToDaemon, getDaemonHost } from "../../utils/client.js";
import type { CommandError, CommandOptions } from "../../output/index.js";
import type {
  CreateScheduleInput,
  ScheduleCadence,
  ScheduleDaemonClient,
  ScheduleListItem,
  ScheduleRecord,
  ScheduleTarget,
  UpdateScheduleInput,
  UpdateScheduleNewAgentConfig,
} from "./types.js";
import { parseDuration } from "../../utils/duration.js";
import { resolveProviderAndModel } from "../../utils/provider-model.js";
import { everyMsToFiveFieldCron } from "@getpaseo/protocol/schedule/cadence";

export interface ScheduleCommandOptions extends CommandOptions {
  host?: string;
}

export function isStandaloneSchedule(schedule: ScheduleRecord | ScheduleListItem): boolean {
  switch (schedule.target.type) {
    case "agent":
      return false;
    case "new-agent":
    case "assignment-team-run":
      return true;
  }
}

export async function connectScheduleClient(
  host: string | undefined,
): Promise<{ client: ScheduleDaemonClient; host: string }> {
  const resolvedHost = getDaemonHost({ host });
  try {
    const client = (await connectToDaemon({
      host,
    })) as unknown as ScheduleDaemonClient;
    return { client, host: resolvedHost };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw {
      code: "DAEMON_NOT_RUNNING",
      message: `Cannot connect to daemon at ${resolvedHost}: ${message}`,
      details: "Start the daemon with: paseo daemon start",
    } satisfies CommandError;
  }
}

export function toScheduleCommandError(code: string, action: string, error: unknown): CommandError {
  if (error && typeof error === "object" && "code" in error) {
    return error as CommandError;
  }
  const message = error instanceof Error ? error.message : String(error);
  return {
    code,
    message: `Failed to ${action}: ${message}`,
  };
}

export async function requireStandaloneSchedule(
  client: ScheduleDaemonClient,
  id: string,
): Promise<ScheduleRecord> {
  const payload = await client.scheduleInspect({ id });
  if (payload.error || !payload.schedule || !isStandaloneSchedule(payload.schedule)) {
    throw new Error(payload.error ?? `Schedule not found: ${id}`);
  }
  return payload.schedule;
}

export function formatCadence(cadence: ScheduleCadence): string {
  if (cadence.type === "cron") {
    const timezoneSuffix = cadence.timezone ? ` (${cadence.timezone})` : "";
    return `cron:${cadence.expression}${timezoneSuffix}`;
  }
  return `every:${formatDurationMs(cadence.everyMs)}`;
}

export function formatTarget(target: ScheduleTarget | ScheduleListItem["target"]): string {
  switch (target.type) {
    case "self":
      return `self:${target.agentId.slice(0, 7)}`;
    case "agent":
      return `agent:${target.agentId.slice(0, 7)}`;
    case "assignment-team-run":
      return `assignment:${target.assignmentId.slice(0, 12)}/team:${target.teamId.slice(0, 12)}`;
    case "new-agent": {
      const modelSuffix = target.config.model ? `/${target.config.model}` : "";
      return `new-agent:${target.config.provider}${modelSuffix}`;
    }
  }
}

export function formatDurationMs(durationMs: number): string {
  const parts: string[] = [];
  let remainingMs = durationMs;
  const hours = Math.floor(remainingMs / (60 * 60 * 1000));
  if (hours > 0) {
    parts.push(`${hours}h`);
    remainingMs -= hours * 60 * 60 * 1000;
  }
  const minutes = Math.floor(remainingMs / (60 * 1000));
  if (minutes > 0) {
    parts.push(`${minutes}m`);
    remainingMs -= minutes * 60 * 1000;
  }
  const seconds = Math.floor(remainingMs / 1000);
  if (seconds > 0 || parts.length === 0) {
    parts.push(`${seconds}s`);
  }
  return parts.join("");
}

function resolveScheduleTarget(args: {
  targetValue: string | undefined;
  hasExplicitNewAgentOption: boolean;
  createNewAgentTarget: () => ScheduleTarget;
}): ScheduleTarget {
  const { targetValue, hasExplicitNewAgentOption, createNewAgentTarget } = args;
  if (!targetValue) {
    return createNewAgentTarget();
  }

  if (targetValue === "new-agent") {
    return createNewAgentTarget();
  }

  if (hasExplicitNewAgentOption) {
    throw {
      code: "INVALID_TARGET",
      message: "--provider/--mode/--thinking can only be used with a new-agent target",
      details: "Use --target new-agent or omit --target to create a new agent schedule",
    } satisfies CommandError;
  }

  if (targetValue === "self") {
    // COMPAT(scheduleSelfTarget): heartbeat creation moved to `paseo heartbeat create`.
    // Added in v0.2.0; remove after 2027-01-17.
    const currentAgentId = process.env.PASEO_AGENT_ID?.trim();
    if (!currentAgentId) {
      throw {
        code: "INVALID_TARGET",
        message: "--target self requires running inside a Paseo agent",
      } satisfies CommandError;
    }
    return { type: "self", agentId: currentAgentId };
  }

  return { type: "agent", agentId: targetValue };
}

interface ScheduleCreateOptions {
  prompt: string;
  every?: string;
  cron?: string;
  timezone?: string;
  name?: string;
  target?: string;
  provider?: string;
  mode?: string;
  thinking?: string;
  cwd?: string;
  assignment?: string;
  team?: string;
  workspace?: string;
  host?: string;
  maxRuns?: string;
  expiresIn?: string;
  runNow?: boolean;
}

function parseAssignmentTeamTarget(options: ScheduleCreateOptions): ScheduleTarget | null {
  const assignmentId = options.assignment?.trim();
  const teamId = options.team?.trim();
  const workspaceId = options.workspace?.trim();
  const hasAnyTargetFlag = Boolean(assignmentId || teamId || workspaceId);
  if (!hasAnyTargetFlag) return null;
  if (!assignmentId || !teamId || !workspaceId) {
    throw {
      code: "INCOMPLETE_ASSIGNMENT_TEAM_TARGET",
      message: "--assignment, --team, and --workspace must be provided together",
    } satisfies CommandError;
  }
  return { type: "assignment-team-run", assignmentId, teamId, workspaceId };
}

function validateAssignmentTeamTargetOptions(
  options: ScheduleCreateOptions,
  target: ScheduleTarget | null,
): void {
  if (target?.type !== "assignment-team-run") return;
  const hasAgentLaunchOption =
    options.provider !== undefined || options.mode !== undefined || options.thinking !== undefined;
  if (hasAgentLaunchOption || options.cwd !== undefined || options.target !== undefined) {
    throw {
      code: "INVALID_ASSIGNMENT_TEAM_TARGET",
      message:
        "--assignment/--team/--workspace cannot be combined with agent target or launch flags",
    } satisfies CommandError;
  }
}

function buildNewAgentTarget(input: {
  options: ScheduleCreateOptions;
  cwd: string | undefined;
  modeId: string | undefined;
  thinkingOptionId: string | undefined;
}): ScheduleTarget {
  const resolvedProviderModel = resolveProviderAndModel({ provider: input.options.provider });
  return {
    type: "new-agent",
    config: {
      provider: resolvedProviderModel.provider,
      cwd: input.cwd ?? process.cwd(),
      ...(resolvedProviderModel.model ? { model: resolvedProviderModel.model } : {}),
      ...(input.modeId ? { modeId: input.modeId } : {}),
      ...(input.thinkingOptionId ? { thinkingOptionId: input.thinkingOptionId } : {}),
    },
  };
}

function buildScheduleCreateLimits(
  options: ScheduleCreateOptions,
): Pick<CreateScheduleInput, "name" | "maxRuns" | "expiresAt"> {
  const name = options.name?.trim();
  const maxRuns =
    options.maxRuns === undefined ? undefined : parsePositiveInt(options.maxRuns, "--max-runs");
  const expiresAt =
    options.expiresIn === undefined
      ? undefined
      : new Date(Date.now() + parseDuration(options.expiresIn)).toISOString();
  return {
    ...(name ? { name } : {}),
    ...(maxRuns !== undefined ? { maxRuns } : {}),
    ...(expiresAt ? { expiresAt } : {}),
  };
}

export function parseScheduleCreateInput(options: ScheduleCreateOptions): CreateScheduleInput {
  const prompt = options.prompt.trim();
  if (!prompt) {
    throw {
      code: "INVALID_PROMPT",
      message: "Schedule prompt cannot be empty",
    } satisfies CommandError;
  }

  const cadence = parseCadenceFromFlags(options.every, options.cron, options.timezone);
  if (!cadence) {
    throw {
      code: "INVALID_CADENCE",
      message: "Specify exactly one of --every or --cron",
    } satisfies CommandError;
  }

  const assignmentTeamTarget = parseAssignmentTeamTarget(options);
  validateAssignmentTeamTargetOptions(options, assignmentTeamTarget);

  const cwdInput = options.cwd?.trim();
  if (options.host !== undefined && !cwdInput && !assignmentTeamTarget) {
    throw {
      code: "MISSING_CWD",
      message:
        "--cwd is required when --host is specified (the local working directory will not exist on the remote daemon)",
    } satisfies CommandError;
  }

  const runOnCreate = resolveRunOnCreate(options.runNow, cadence.type);

  const targetValue = options.target?.trim();
  const modeId = options.mode?.trim();
  const thinkingOptionId = options.thinking?.trim();
  if (options.thinking !== undefined && !thinkingOptionId) {
    throw {
      code: "INVALID_THINKING_OPTION",
      message: "--thinking cannot be empty",
    } satisfies CommandError;
  }
  const hasExplicitNewAgentOption =
    options.provider !== undefined || options.mode !== undefined || options.thinking !== undefined;
  const createNewAgentTarget = (): ScheduleTarget => {
    return buildNewAgentTarget({
      options,
      cwd: cwdInput,
      modeId,
      thinkingOptionId,
    });
  };
  const target =
    assignmentTeamTarget ??
    resolveScheduleTarget({ targetValue, hasExplicitNewAgentOption, createNewAgentTarget });

  return {
    prompt,
    cadence,
    target,
    runOnCreate,
    ...buildScheduleCreateLimits(options),
  };
}

function resolveRunOnCreate(
  runNow: boolean | undefined,
  _cadenceType: ScheduleCadence["type"],
): boolean {
  return runNow ?? false;
}

export interface ScheduleUpdateOptionsInput {
  id: string;
  every?: string;
  cron?: string;
  timezone?: string;
  name?: string;
  prompt?: string;
  provider?: string;
  model?: string;
  mode?: string;
  cwd?: string;
  maxRuns?: string;
  expiresIn?: string;
  clearMaxRuns?: boolean;
  clearExpires?: boolean;
}

export function parseScheduleUpdateInput(options: ScheduleUpdateOptionsInput): UpdateScheduleInput {
  const id = options.id.trim();
  if (!id) {
    throw {
      code: "INVALID_SCHEDULE_ID",
      message: "Schedule id cannot be empty",
    } satisfies CommandError;
  }

  const cadence = parseCadenceFromFlags(options.every, options.cron, options.timezone);
  const newAgentConfig = buildNewAgentConfigPatch(options);
  const maxRuns = parseUpdateMaxRuns(options);
  const expiresAt = parseUpdateExpiresAt(options);
  const name = parseUpdateName(options);
  const prompt = parseUpdatePrompt(options);

  if (
    name === undefined &&
    prompt === undefined &&
    cadence === undefined &&
    newAgentConfig === undefined &&
    maxRuns === undefined &&
    expiresAt === undefined
  ) {
    throw {
      code: "NO_UPDATES",
      message: "Specify at least one field to update",
    } satisfies CommandError;
  }

  return {
    id,
    ...(name !== undefined ? { name } : {}),
    ...(prompt !== undefined ? { prompt } : {}),
    ...(cadence !== undefined ? { cadence } : {}),
    ...(newAgentConfig !== undefined ? { newAgentConfig } : {}),
    ...(maxRuns !== undefined ? { maxRuns } : {}),
    ...(expiresAt !== undefined ? { expiresAt } : {}),
  };
}

function parseCadenceFromFlags(
  every: string | undefined,
  cron: string | undefined,
  timezone: string | undefined,
): ScheduleCadence | undefined {
  if (every !== undefined && cron !== undefined) {
    throw {
      code: "INVALID_CADENCE",
      message: "Specify at most one of --every or --cron",
    } satisfies CommandError;
  }
  const trimmedTimeZone = parseTimeZoneFlag(timezone);
  if (trimmedTimeZone !== undefined && cron === undefined) {
    throw {
      code: "INVALID_TIME_ZONE",
      message: "--timezone can only be used with --cron",
    } satisfies CommandError;
  }
  if (every !== undefined) {
    return { type: "cron", expression: compileEveryPresetToCron(every) };
  }
  if (cron !== undefined) {
    return {
      type: "cron",
      expression: cron.trim(),
      ...(trimmedTimeZone ? { timezone: trimmedTimeZone } : {}),
    };
  }
  return undefined;
}

export function compileEveryPresetToCron(value: string): string {
  const durationMs = parseDuration(value);
  const cron = everyMsToFiveFieldCron(durationMs);
  if (cron) {
    return cron;
  }

  throw {
    code: "UNREPRESENTABLE_CADENCE",
    message: `${value} cannot be represented faithfully by five-field cron`,
    details: "Use --cron for calendar schedules",
  } satisfies CommandError;
}

function parseTimeZoneFlag(timeZone: string | undefined): string | undefined {
  if (timeZone === undefined) {
    return undefined;
  }
  const trimmed = timeZone.trim();
  if (!trimmed) {
    throw {
      code: "INVALID_TIME_ZONE",
      message: "--timezone cannot be empty",
    } satisfies CommandError;
  }
  return trimmed;
}

function parseUpdateMaxRuns(options: ScheduleUpdateOptionsInput): number | null | undefined {
  if (options.maxRuns !== undefined && options.clearMaxRuns) {
    throw {
      code: "CONFLICTING_MAX_RUNS",
      message: "Use either --max-runs <n> or --no-max-runs, not both",
    } satisfies CommandError;
  }
  if (options.clearMaxRuns) {
    return null;
  }
  if (options.maxRuns !== undefined) {
    return parsePositiveInt(options.maxRuns, "--max-runs");
  }
  return undefined;
}

function parseUpdateExpiresAt(options: ScheduleUpdateOptionsInput): string | null | undefined {
  if (options.expiresIn !== undefined && options.clearExpires) {
    throw {
      code: "CONFLICTING_EXPIRES",
      message: "Use either --expires-in <duration> or --no-expires-in, not both",
    } satisfies CommandError;
  }
  if (options.clearExpires) {
    return null;
  }
  if (options.expiresIn !== undefined) {
    return new Date(Date.now() + parseDuration(options.expiresIn)).toISOString();
  }
  return undefined;
}

function parseUpdateName(options: ScheduleUpdateOptionsInput): string | null | undefined {
  if (options.name === undefined) {
    return undefined;
  }
  const trimmed = options.name.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parseUpdatePrompt(options: ScheduleUpdateOptionsInput): string | undefined {
  if (options.prompt === undefined) {
    return undefined;
  }
  const trimmed = options.prompt.trim();
  if (!trimmed) {
    throw {
      code: "INVALID_PROMPT",
      message: "--prompt cannot be empty",
    } satisfies CommandError;
  }
  return trimmed;
}

function buildNewAgentConfigPatch(
  options: ScheduleUpdateOptionsInput,
): UpdateScheduleNewAgentConfig | undefined {
  const patch: UpdateScheduleNewAgentConfig = {};
  if (options.provider !== undefined || options.model !== undefined) {
    const resolved = resolveProviderAndModel({
      provider: options.provider,
      model: options.model,
    });
    patch.provider = resolved.provider;
    if (resolved.model !== undefined) {
      patch.model = resolved.model;
    }
  }
  if (options.mode !== undefined) {
    const trimmed = options.mode.trim();
    patch.modeId = trimmed.length > 0 ? trimmed : null;
  }
  if (options.cwd !== undefined) {
    const trimmed = options.cwd.trim();
    if (!trimmed) {
      throw {
        code: "INVALID_CWD",
        message: "--cwd cannot be empty",
      } satisfies CommandError;
    }
    patch.cwd = trimmed;
  }
  return Object.keys(patch).length > 0 ? patch : undefined;
}

function parsePositiveInt(value: string, flag: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw {
      code: "INVALID_INTEGER",
      message: `${flag} must be a positive integer`,
    } satisfies CommandError;
  }
  return parsed;
}

export interface ScheduleRow {
  id: string;
  name: string | null;
  cadence: string;
  target: string;
  status: string;
  nextRunAt: string | null;
  lastRunAt: string | null;
}

export function toScheduleRow(schedule: ScheduleListItem | ScheduleRecord): ScheduleRow {
  return {
    id: schedule.id,
    name: schedule.name,
    cadence: formatCadence(schedule.cadence),
    target: formatTarget(schedule.target),
    status: schedule.status,
    nextRunAt: schedule.nextRunAt,
    lastRunAt: schedule.lastRunAt,
  };
}
