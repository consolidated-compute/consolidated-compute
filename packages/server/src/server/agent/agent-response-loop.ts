import { z } from "zod";
import Ajv, { type ErrorObject, type Options as AjvOptions } from "ajv";
import type { AgentProvider, AgentSessionConfig } from "./agent-sdk-types.js";
import type { AgentManager } from "./agent-manager.js";

export interface StructuredGenerationLogger {
  info: (obj: object, msg?: string) => void;
  warn: (obj: object, msg?: string) => void;
}

export type JsonSchema = Record<string, unknown>;

export type AgentCaller = (prompt: string) => Promise<string>;

export class StructuredAgentResponseError extends Error {
  readonly lastResponse: string;
  readonly validationErrors: string[];

  constructor(message: string, options: { lastResponse: string; validationErrors: string[] }) {
    super(message);
    this.name = "StructuredAgentResponseError";
    this.lastResponse = options.lastResponse;
    this.validationErrors = options.validationErrors;
  }
}

export interface StructuredGenerationProvider {
  provider: AgentProvider;
  model?: string;
  thinkingOptionId?: string;
}

export interface StructuredGenerationAttempt {
  provider: AgentProvider;
  model: string | null;
  available: boolean;
  error: string | null;
}

export class StructuredAgentFallbackError extends Error {
  readonly attempts: StructuredGenerationAttempt[];

  constructor(attempts: StructuredGenerationAttempt[]) {
    const summary = attempts
      .map((attempt) => {
        const modelSuffix = attempt.model ? ` (${attempt.model})` : "";
        if (!attempt.available) {
          return `${attempt.provider}${modelSuffix}: unavailable${attempt.error ? ` (${attempt.error})` : ""}`;
        }
        return `${attempt.provider}${modelSuffix}: failed${attempt.error ? ` (${attempt.error})` : ""}`;
      })
      .join("; ");

    super(
      summary.length > 0
        ? `Structured generation failed for all providers: ${summary}`
        : "Structured generation failed for all providers",
    );
    this.name = "StructuredAgentFallbackError";
    this.attempts = attempts;
  }
}

export interface StructuredAgentResponseOptions<T> {
  caller: AgentCaller;
  prompt: string;
  schema: z.ZodType<T> | JsonSchema;
  maxRetries?: number;
  schemaName?: string;
  maxPromptBytes?: number;
}

export interface StructuredAgentGenerationOptions<T> {
  manager: AgentManager;
  agentConfig: AgentSessionConfig;
  agentId?: string;
  persistSession?: boolean;
  prompt: string;
  schema: z.ZodType<T> | JsonSchema;
  maxRetries?: number;
  schemaName?: string;
}

export interface StructuredAgentGenerationWithFallbackOptions<T> {
  manager: AgentManager;
  cwd: string;
  prompt: string;
  schema: z.ZodType<T> | JsonSchema;
  providers: readonly StructuredGenerationProvider[];
  agentConfigOverrides?: Omit<
    AgentSessionConfig,
    "provider" | "cwd" | "model" | "thinkingOptionId"
  >;
  persistSession?: boolean;
  maxRetries?: number;
  schemaName?: string;
  logger?: StructuredGenerationLogger;
  runner?: <TResult>(options: StructuredAgentGenerationOptions<TResult>) => Promise<TResult>;
}

// Re-export from the legacy module path so existing server consumers keep working.
export { DEFAULT_STRUCTURED_GENERATION_PROVIDERS } from "./structured-generation-providers.js";

interface SchemaValidator<T> {
  jsonSchema: JsonSchema;
  validate: (value: unknown) => { ok: true; value: T } | { ok: false; errors: string[] };
}

function isZodSchema(value: unknown): value is z.ZodType {
  return typeof (value as z.ZodType | undefined)?.safeParse === "function";
}

function buildZodValidator<T>(schema: z.ZodType, schemaName: string): SchemaValidator<T> {
  const jsonSchema = z.toJSONSchema(schema, {
    target: "draft-07",
    unrepresentable: "any",
    io: "input",
  }) as JsonSchema;
  if (typeof jsonSchema.title !== "string") {
    jsonSchema.title = schemaName;
  }
  return {
    jsonSchema,
    validate: (value) => {
      const result = schema.safeParse(value);
      if (result.success) {
        return { ok: true, value: result.data as T };
      }
      const errors = result.error.issues.map((issue) => {
        const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
        return `${path}: ${issue.message}`;
      });
      return { ok: false, errors };
    },
  };
}

function buildJsonSchemaValidator<T>(schema: JsonSchema): SchemaValidator<T> {
  const AjvConstructor = Ajv as unknown as {
    new (options?: AjvOptions): {
      compile: (input: JsonSchema) => ((value: unknown) => boolean) & {
        errors?: ErrorObject[] | null;
      };
    };
  };
  const ajv = new AjvConstructor({ allErrors: true, strict: false });
  const validate = ajv.compile(schema);
  return {
    jsonSchema: schema,
    validate: (value) => {
      const ok = validate(value);
      if (ok) {
        return { ok: true, value: value as T };
      }
      const errors = (validate.errors ?? []).map((error: ErrorObject) => {
        const path =
          error.instancePath && error.instancePath.length > 0 ? error.instancePath : "(root)";
        const message = error.message ?? "is invalid";
        return `${path}: ${message}`;
      });
      return { ok: false, errors };
    },
  };
}

function buildValidator<T>(
  schema: z.ZodType<T> | JsonSchema,
  schemaName: string,
): SchemaValidator<T> {
  if (isZodSchema(schema)) {
    return buildZodValidator(schema, schemaName);
  }
  return buildJsonSchemaValidator(schema);
}

function buildBasePrompt(prompt: string, jsonSchema: JsonSchema): string {
  const schemaText = JSON.stringify(jsonSchema, null, 2);
  return [
    prompt.trim(),
    "",
    "You must respond with JSON only that matches this JSON Schema:",
    schemaText,
  ].join("\n");
}

export function buildStructuredAgentResponsePrompt(options: {
  prompt: string;
  schema: z.ZodType | JsonSchema;
  schemaName?: string;
}): string {
  const validator = buildValidator(options.schema, options.schemaName ?? "Response");
  return buildBasePrompt(options.prompt, validator.jsonSchema);
}

function buildRetryPrompt(basePrompt: string, errors: string[], maxPromptBytes?: number): string {
  const prefix = [basePrompt, "", "Previous response was invalid with validation errors:"].join(
    "\n",
  );
  const suffix = "Respond again with JSON only that matches the schema.";
  if (maxPromptBytes === undefined) {
    const formattedErrors = errors.map((error) => `- ${error}`).join("\n");
    return [
      prefix,
      formattedErrors.length > 0 ? formattedErrors : "- Unknown validation error",
      "",
      suffix,
    ].join("\n");
  }

  const fixedBytes = Buffer.byteLength(`${prefix}\n\n\n${suffix}`, "utf8");
  const diagnosticsBudget = maxPromptBytes - fixedBytes;
  if (diagnosticsBudget <= 0) {
    throw new StructuredAgentResponseError("Structured retry prompt exceeds its byte budget", {
      lastResponse: "",
      validationErrors: errors,
    });
  }
  const diagnostics = formatBoundedValidationErrors(errors, diagnosticsBudget);
  return [prefix, diagnostics, "", suffix].join("\n");
}

function formatBoundedValidationErrors(errors: string[], maxBytes: number): string {
  const source = errors.length > 0 ? errors : ["Unknown validation error"];
  const included: string[] = [];
  for (const error of source) {
    const line = `- ${error}`;
    const omitted = source.length - included.length - 1;
    const marker = omitted > 0 ? `\n- [${omitted} validation errors omitted]` : "";
    const candidate = [...included, line].join("\n") + marker;
    if (Buffer.byteLength(candidate, "utf8") > maxBytes) break;
    included.push(line);
  }
  const omitted = source.length - included.length;
  if (omitted === 0) return included.join("\n");
  const marker = `- [${omitted} validation errors omitted]`;
  const candidate = [...included, marker].join("\n");
  if (Buffer.byteLength(candidate, "utf8") <= maxBytes) return candidate;
  return truncateUtf8(marker, maxBytes);
}

function truncateUtf8(value: string, maxBytes: number): string {
  const included: string[] = [];
  let includedBytes = 0;
  for (const codePoint of value) {
    const codePointBytes = Buffer.byteLength(codePoint, "utf8");
    if (includedBytes + codePointBytes > maxBytes) break;
    included.push(codePoint);
    includedBytes += codePointBytes;
  }
  return included.join("");
}

function extractJsonFromMarkdown(text: string): string {
  const fencedMatch = text.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  if (fencedMatch) {
    return fencedMatch[1].trim();
  }

  const extracted = extractFirstJsonSnippet(text);
  if (extracted) {
    return extracted;
  }

  return text.trim();
}

function tryParseJson(candidate: string): string | null {
  try {
    JSON.parse(candidate);
    return candidate;
  } catch {
    return null;
  }
}

function extractBalancedJsonCandidate(source: string, start: number): string | null {
  const open = source[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < source.length; i += 1) {
    const ch = source[i];

    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }

    if (ch === open) {
      depth += 1;
      continue;
    }
    if (ch !== close) {
      continue;
    }
    depth -= 1;
    if (depth !== 0) {
      continue;
    }
    const candidate = source.slice(start, i + 1).trim();
    const parsed = tryParseJson(candidate);
    if (parsed !== null) {
      return parsed;
    }
  }

  return null;
}

function extractFirstJsonSnippet(text: string): string | null {
  const source = text.trim();
  if (!source) {
    return null;
  }

  // Try to find the first valid JSON object/array within a larger response.
  // This is intentionally provider-agnostic and improves resilience when models
  // add extra prose before/after the JSON.
  const startIndexes: number[] = [];
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === "{" || ch === "[") {
      startIndexes.push(i);
    }
  }

  for (const start of startIndexes) {
    const candidate = extractBalancedJsonCandidate(source, start);
    if (candidate !== null) {
      return candidate;
    }
  }

  return null;
}

export async function getStructuredAgentResponse<T>(
  options: StructuredAgentResponseOptions<T>,
): Promise<T> {
  const {
    caller,
    prompt,
    schema,
    maxRetries = 2,
    schemaName = "Response",
    maxPromptBytes,
  } = options;
  const validator = buildValidator(schema, schemaName);
  const basePrompt = buildBasePrompt(prompt, validator.jsonSchema);
  if (maxPromptBytes !== undefined && Buffer.byteLength(basePrompt, "utf8") > maxPromptBytes) {
    throw new StructuredAgentResponseError("Structured prompt exceeds its byte budget", {
      lastResponse: "",
      validationErrors: [],
    });
  }

  let attemptPrompt = basePrompt;
  let lastResponse = "";
  let lastErrors: string[] = [];

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const response = await caller(attemptPrompt);
    lastResponse = response;
    const jsonText = extractJsonFromMarkdown(response);

    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonText);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      lastErrors = [`Invalid JSON: ${message}`];
      if (attempt === maxRetries) {
        break;
      }
      attemptPrompt = buildRetryPrompt(basePrompt, lastErrors, maxPromptBytes);
      continue;
    }

    const validation = validator.validate(parsed);
    if (validation.ok) {
      return validation.value;
    }

    lastErrors = validation.errors;
    if (attempt === maxRetries) {
      break;
    }
    attemptPrompt = buildRetryPrompt(basePrompt, lastErrors, maxPromptBytes);
  }

  throw new StructuredAgentResponseError("Agent response did not match the required JSON schema", {
    lastResponse,
    validationErrors: lastErrors,
  });
}

export async function generateStructuredAgentResponse<T>(
  options: StructuredAgentGenerationOptions<T>,
): Promise<T> {
  const { manager, agentConfig, agentId, persistSession, prompt, schema, maxRetries, schemaName } =
    options;
  const agent = await manager.createAgent(agentConfig, agentId, {
    persistSession,
    workspaceId: undefined,
  });
  try {
    const caller: AgentCaller = async (nextPrompt) => {
      const result = await manager.runAgent(agent.id, nextPrompt);
      if (typeof result.finalText === "string" && result.finalText.length > 0) {
        return result.finalText;
      }
      // Fallback for providers that may not populate finalText consistently.
      const lastAssistant = result.timeline.findLast((item) => item.type === "assistant_message");
      return lastAssistant?.text ?? "";
    };
    return await getStructuredAgentResponse({
      caller,
      prompt,
      schema,
      maxRetries,
      schemaName,
    });
  } finally {
    try {
      await manager.closeAgent(agent.id);
    } catch {
      // ignore cleanup errors
    } finally {
      await manager.deleteAgentState(agent.id).catch(() => undefined);
    }
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

export async function generateStructuredAgentResponseWithFallback<T>(
  options: StructuredAgentGenerationWithFallbackOptions<T>,
): Promise<T> {
  const {
    manager,
    cwd,
    prompt,
    schema,
    providers,
    agentConfigOverrides,
    persistSession,
    maxRetries,
    schemaName,
    logger,
    runner,
  } = options;

  if (providers.length === 0) {
    throw new StructuredAgentFallbackError([]);
  }

  const runStructured =
    runner ??
    ((input: StructuredAgentGenerationOptions<T>) => generateStructuredAgentResponse<T>(input));
  const attempts: StructuredGenerationAttempt[] = [];

  for (const candidate of providers) {
    const availabilityEntry = await manager.getProviderAvailability(candidate.provider);
    if (!availabilityEntry.available) {
      const reason = availabilityEntry.error ?? "unavailable";
      attempts.push({
        provider: candidate.provider,
        model: candidate.model ?? null,
        available: false,
        error: availabilityEntry.error ?? null,
      });
      logger?.warn(
        { provider: candidate.provider, model: candidate.model, schemaName, reason },
        "Structured generation: skipping unavailable provider",
      );
      continue;
    }

    try {
      const result = await runStructured({
        manager,
        prompt,
        schema,
        maxRetries,
        schemaName,
        persistSession,
        agentConfig: {
          ...agentConfigOverrides,
          provider: candidate.provider,
          cwd,
          ...(candidate.model ? { model: candidate.model } : {}),
          ...(candidate.thinkingOptionId ? { thinkingOptionId: candidate.thinkingOptionId } : {}),
        },
      });
      if (attempts.length > 0) {
        logger?.info(
          {
            provider: candidate.provider,
            model: candidate.model,
            schemaName,
            priorAttempts: attempts,
          },
          "Structured generation: succeeded after fallback",
        );
      }
      return result;
    } catch (error) {
      attempts.push({
        provider: candidate.provider,
        model: candidate.model ?? null,
        available: true,
        error: errorMessage(error),
      });
      logger?.warn(
        { err: error, provider: candidate.provider, model: candidate.model, schemaName },
        "Structured generation: provider failed, trying next",
      );
    }
  }

  throw new StructuredAgentFallbackError(attempts);
}
