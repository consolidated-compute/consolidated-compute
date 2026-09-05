import { homedir } from "node:os";
import { z } from "zod";
import {
  ForgeRepositorySearchInputSchema,
  ForgeRepositoryWorkSearchInputSchema,
  type ForgeRepositoryIdentity,
  type ForgeRepositoryWorkPage,
} from "@getpaseo/protocol/forge-repositories";
import {
  createForgeCliRunner,
  ForgeAuthenticationError,
  ForgeCliMissingError,
  ForgeCommandError,
  type ForgeCliRunner,
} from "./forge-cli-command.js";
import {
  ForgeRepositoryDiscoveryError,
  type ForgeRepositoryDiscovery,
} from "./forge-repository-discovery.js";

const repositoryFields = "id nameWithOwner url sshUrl visibility isArchived updatedAt";
const repositorySchema = z.object({
  id: z.string(),
  nameWithOwner: z.string(),
  url: z.string(),
  sshUrl: z.string(),
  visibility: z.string(),
  isArchived: z.boolean(),
  updatedAt: z.string(),
});
const pageInfoSchema = z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() });
const repositoryConnectionSchema = z.object({
  nodes: z.array(repositorySchema).max(50),
  pageInfo: pageInfoSchema,
});
const workSchema = z.object({
  __typename: z.enum(["Issue", "PullRequest"]),
  id: z.string(),
  number: z.number().int().positive(),
  title: z.string(),
  url: z.string(),
  state: z.string(),
  body: z.string(),
  updatedAt: z.string(),
  repository: z.object({ id: z.string() }),
  labels: z.object({ nodes: z.array(z.object({ name: z.string() })) }),
});
const workConnectionSchema = z.object({
  nodes: z.array(workSchema).max(50),
  pageInfo: pageInfoSchema,
});

const cli = createForgeCliRunner({
  binary: "gh",
  envOverlay: { GH_PROMPT_DISABLED: "1", GH_PAGER: "cat" },
  timeoutMs: 15_000,
  isAuthFailureText: (text) =>
    /gh auth login|not logged|authentication|bad credentials/i.test(text),
  errorClasses: {
    isAlreadyClassified: (error) => error instanceof ForgeAuthenticationError,
    isCommandError: (error): error is ForgeCommandError => error instanceof ForgeCommandError,
    createAuthError: (stderr) =>
      new ForgeAuthenticationError("GitHub authentication failed", { stderr }),
    createMissingError: () => new ForgeCliMissingError("Install GitHub CLI (gh) on the host."),
    createCommandError: (params) =>
      new ForgeCommandError({ brand: "GitHub", binary: "gh" }, params),
  },
});

/** Uses the existing host CLI credential path; no checkout, token export, or installation store. */
export function createGitHubRepositoryDiscovery(
  options: { run?: ForgeCliRunner; cwd?: string } = {},
): ForgeRepositoryDiscovery {
  const run = options.run ?? cli.run;
  const cwd = options.cwd ?? homedir();

  async function command(args: string[], host: string): Promise<string> {
    try {
      return (await run(args, { cwd, envOverlay: { GH_HOST: host, GH_PROMPT_DISABLED: "1" } }))
        .stdout;
    } catch (error) {
      const normalized = cli.normalizeError(error, { args, cwd });
      if (normalized instanceof ForgeCliMissingError) {
        throw new ForgeRepositoryDiscoveryError(
          "cli_missing",
          "Install GitHub CLI (gh) on the host.",
        );
      }
      if (normalized instanceof ForgeAuthenticationError) {
        throw new ForgeRepositoryDiscoveryError(
          "unauthenticated",
          `Sign in with gh auth login --hostname ${host} on the host.`,
        );
      }
      const detail = normalized instanceof ForgeCommandError ? normalized.stderr : "";
      if (/rate limit|secondary rate|abuse detection/i.test(detail)) {
        throw new ForgeRepositoryDiscoveryError(
          "rate_limited",
          "GitHub rate limit reached. Retry later.",
        );
      }
      throw new ForgeRepositoryDiscoveryError(
        "provider_error",
        "GitHub discovery failed. Check host connectivity and repository access, then retry.",
      );
    }
  }

  async function authenticate(forge: string, rawHost: string): Promise<string> {
    if (forge !== "github")
      throw new ForgeRepositoryDiscoveryError(
        "unsupported",
        "This adapter supports GitHub repository discovery.",
      );
    const host = rawHost.toLowerCase();
    // A client-selected Enterprise host must already be trusted by the local CLI.
    // Do not probe remote HTTP endpoints or send credentials before this succeeds.
    await command(["auth", "status", "--hostname", host], host);
    return host;
  }

  async function graphql(
    query: string,
    variables: Record<string, string | number | undefined>,
    host: string,
  ): Promise<unknown> {
    const args = ["api", "--hostname", host, "graphql", "-f", `query=${query}`];
    for (const [key, value] of Object.entries(variables)) {
      if (value !== undefined)
        args.push(typeof value === "number" ? "-F" : "-f", `${key}=${value}`);
    }
    const stdout = await command(args, host);
    let value: unknown;
    try {
      value = JSON.parse(stdout);
    } catch {
      throw new ForgeRepositoryDiscoveryError(
        "provider_error",
        "GitHub returned invalid discovery data. Retry the request.",
      );
    }
    const result = parseProviderResponse(
      z.object({ data: z.unknown(), errors: z.array(z.unknown()).optional() }),
      value,
    );
    if (result.errors?.length)
      throw new ForgeRepositoryDiscoveryError(
        "provider_error",
        "GitHub returned incomplete discovery data. Retry the request.",
      );
    return result.data;
  }

  return {
    async searchRepositories(input) {
      const parsed = ForgeRepositorySearchInputSchema.parse(input);
      const host = await authenticate(parsed.forge, parsed.host);
      const query = parsed.query?.trim();
      const variables = { limit: parsed.limit ?? 20, cursor: parsed.cursor };
      const connection = query
        ? parseProviderResponse(
            z.object({ search: repositoryConnectionSchema }),
            await graphql(
              `query($searchQuery:String!,$limit:Int!,$cursor:String){ search(type:REPOSITORY,query:$searchQuery,first:$limit,after:$cursor){ nodes{ ... on Repository{${repositoryFields}} } pageInfo{hasNextPage endCursor} } }`,
              // GitHub search omits forks by default, even repositories the operator owns.
              { ...variables, searchQuery: `${query} fork:true` },
              host,
            ),
          ).search
        : parseProviderResponse(
            z.object({ viewer: z.object({ repositories: repositoryConnectionSchema }) }),
            await graphql(
              `query($limit:Int!,$cursor:String){ viewer{ repositories(first:$limit,after:$cursor,affiliations:[OWNER,COLLABORATOR,ORGANIZATION_MEMBER],orderBy:{field:UPDATED_AT,direction:DESC}){ nodes{${repositoryFields}} pageInfo{hasNextPage endCursor} } } }`,
              variables,
              host,
            ),
          ).viewer.repositories;
      return {
        items: connection.nodes.map((repository) => ({
          forge: "github",
          host,
          id: repository.id,
          fullName: repository.nameWithOwner,
          url: repository.url,
          cloneUrl: repository.url,
          sshUrl: repository.sshUrl,
          visibility: repository.visibility.toLowerCase(),
          archived: repository.isArchived,
          updatedAt: repository.updatedAt,
        })),
        nextCursor: nextCursor(connection.pageInfo),
      };
    },
    async searchWork(input) {
      const parsed = ForgeRepositoryWorkSearchInputSchema.parse(input);
      const host = await authenticate(parsed.repository.forge, parsed.repository.host);
      const identity: ForgeRepositoryIdentity = { ...parsed.repository, host };
      // Resolve the immutable provider ID on every read so a rename cannot redirect the query.
      const resolved = parseProviderResponse(
        z.object({ node: repositorySchema.nullable() }),
        await graphql(
          `query($id:ID!){node(id:$id){... on Repository{${repositoryFields}}}}`,
          { id: identity.id },
          host,
        ),
      ).node;
      if (!resolved || resolved.id !== identity.id)
        throw new ForgeRepositoryDiscoveryError(
          "not_found",
          "The selected repository is unavailable to this host.",
        );
      const kind = parsed.kind === "issue" ? "issue" : "pr";
      const state = parsed.state ?? "open";
      const search = `repo:${resolved.nameWithOwner} is:${kind}${state === "all" ? "" : ` is:${state}`} ${parsed.query ?? ""}`;
      const fields =
        "__typename id number title url state body updatedAt repository{id} labels(first:20){nodes{name}}";
      const connection = parseProviderResponse(
        z.object({ search: workConnectionSchema }),
        await graphql(
          `query($searchQuery:String!,$limit:Int!,$cursor:String){search(type:ISSUE,query:$searchQuery,first:$limit,after:$cursor){nodes{... on Issue{${fields}} ... on PullRequest{${fields}}} pageInfo{hasNextPage endCursor}}}`,
          { searchQuery: search, limit: parsed.limit ?? 20, cursor: parsed.cursor },
          host,
        ),
      ).search;
      const items: ForgeRepositoryWorkPage["items"] = connection.nodes.map((item) => {
        const itemKind = item.__typename === "Issue" ? "issue" : "change_request";
        if (
          item.repository.id !== identity.id ||
          itemKind !== parsed.kind ||
          (state !== "all" && (item.state === "OPEN" ? "open" : "closed") !== state)
        ) {
          throw new ForgeRepositoryDiscoveryError(
            "invalid_query",
            "Search filters must stay within the selected repository, work kind, and state.",
          );
        }
        const body = boundedBody(item.body);
        return {
          repository: identity,
          id: item.id,
          kind: itemKind,
          number: item.number,
          title: item.title,
          url: item.url,
          state: item.state.toLowerCase(),
          body,
          bodyTruncated: body !== item.body,
          labels: item.labels.nodes.map(({ name }) => name),
          updatedAt: item.updatedAt,
        };
      });
      return { items, nextCursor: nextCursor(connection.pageInfo) };
    },
  };
}

function parseProviderResponse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success)
    throw new ForgeRepositoryDiscoveryError(
      "provider_error",
      "GitHub returned invalid discovery data. Retry the request.",
    );
  return parsed.data;
}

function nextCursor(page: z.infer<typeof pageInfoSchema>): string | null {
  if (page.hasNextPage && !page.endCursor)
    throw new ForgeRepositoryDiscoveryError(
      "provider_error",
      "GitHub omitted the next page cursor.",
    );
  return page.hasNextPage ? page.endCursor : null;
}

function boundedBody(body: string): string {
  const bytes = Buffer.from(body, "utf8");
  if (bytes.length <= 32_768) return body;
  let end = 32_768;
  while ((bytes[end]! & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString("utf8");
}
