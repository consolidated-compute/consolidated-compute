import { z } from "zod";

// Hostnames only: never let repository discovery turn a URL into a credential destination.
export const ForgeRepositoryHostSchema = z
  .string()
  .min(1)
  .max(253)
  .regex(
    /^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/,
  );

export const ForgeRepositoryIdentitySchema = z.object({
  forge: z.string().min(1).max(64),
  host: ForgeRepositoryHostSchema,
  id: z.string().min(1).max(256),
});

export const ForgeRepositorySchema = ForgeRepositoryIdentitySchema.extend({
  fullName: z.string(),
  url: z.string(),
  cloneUrl: z.string(),
  sshUrl: z.string().optional(),
  visibility: z.string(),
  archived: z.boolean(),
  updatedAt: z.string(),
});

const pageFields = {
  query: z.string().max(512).optional(),
  limit: z.number().int().min(1).max(50).optional(),
  cursor: z.string().min(1).max(2048).optional(),
};

export const ForgeRepositorySearchInputSchema = z.object({
  forge: z.string().min(1).max(64),
  host: ForgeRepositoryHostSchema,
  ...pageFields,
});

export const ForgeRepositoryWorkSearchInputSchema = z.object({
  repository: ForgeRepositoryIdentitySchema,
  kind: z.enum(["issue", "change_request"]),
  state: z.enum(["open", "closed", "all"]).optional(),
  ...pageFields,
});

export const ForgeRepositoryWorkItemSchema = z.object({
  repository: ForgeRepositoryIdentitySchema,
  id: z.string(),
  kind: z.enum(["issue", "change_request"]),
  number: z.number().int().positive(),
  title: z.string(),
  url: z.string(),
  state: z.string(),
  body: z.string(),
  bodyTruncated: z.boolean(),
  labels: z.array(z.string()),
  updatedAt: z.string(),
});

export const ForgeRepositoryPageSchema = z.object({
  items: z.array(ForgeRepositorySchema),
  nextCursor: z.string().nullable(),
});
export const ForgeRepositoryWorkPageSchema = z.object({
  items: z.array(ForgeRepositoryWorkItemSchema),
  nextCursor: z.string().nullable(),
});

export const ForgeRepositoriesSearchRequestSchema = ForgeRepositorySearchInputSchema.extend({
  type: z.literal("forge.repositories.search.request"),
  requestId: z.string(),
});
export const ForgeRepositoryWorkSearchRequestSchema = ForgeRepositoryWorkSearchInputSchema.extend({
  type: z.literal("forge.repositories.search_work.request"),
  requestId: z.string(),
});
export const ForgeRepositoriesSearchResponseSchema = z.object({
  type: z.literal("forge.repositories.search.response"),
  payload: ForgeRepositoryPageSchema.extend({ requestId: z.string() }),
});
export const ForgeRepositoryWorkSearchResponseSchema = z.object({
  type: z.literal("forge.repositories.search_work.response"),
  payload: ForgeRepositoryWorkPageSchema.extend({ requestId: z.string() }),
});

export type ForgeRepositoryIdentity = z.infer<typeof ForgeRepositoryIdentitySchema>;
export type ForgeRepositorySearchInput = z.infer<typeof ForgeRepositorySearchInputSchema>;
export type ForgeRepositoryWorkSearchInput = z.infer<typeof ForgeRepositoryWorkSearchInputSchema>;
export type ForgeRepositoryPage = z.infer<typeof ForgeRepositoryPageSchema>;
export type ForgeRepositoryWorkPage = z.infer<typeof ForgeRepositoryWorkPageSchema>;
