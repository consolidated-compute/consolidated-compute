import { describe, expect, it } from "vitest";
import { createGitHubRepositoryDiscovery } from "./github-repository-discovery.js";
import {
  createForgeCliRunner,
  ForgeCommandError,
  type ForgeCliRunner,
} from "./forge-cli-command.js";

const repository = {
  id: "R_selected",
  nameWithOwner: "acme/project",
  url: "https://github.com/acme/project",
  sshUrl: "git@github.com:acme/project.git",
  visibility: "PRIVATE",
  isArchived: false,
  updatedAt: "2026-09-05T10:00:00Z",
};

const identity = { forge: "github", host: "github.com", id: repository.id };
const work = {
  __typename: "Issue",
  id: "I_selected",
  number: 131,
  title: "Repository discovery",
  url: `${repository.url}/issues/131`,
  state: "OPEN",
  body: "Issue body",
  updatedAt: repository.updatedAt,
  repository: { id: repository.id },
  labels: { nodes: [{ name: "enhancement" }] },
};
const lastPage = { hasNextPage: false, endCursor: "last" };

function workResponses(item = work) {
  return [
    {},
    { data: { node: repository } },
    { data: { search: { nodes: [item], pageInfo: lastPage } } },
  ];
}

function fixture(responses: unknown[]) {
  const calls: Array<{ args: string[]; cwd: string; envOverlay?: Record<string, string> }> = [];
  const run: ForgeCliRunner = async (args, options) => {
    calls.push({ args, ...options });
    if (responses.length === 0) throw new Error("Unexpected CLI call");
    const response = responses.shift();
    if (response instanceof Error) throw response;
    return { stdout: JSON.stringify(response), stderr: "" };
  };
  return { calls, discovery: createGitHubRepositoryDiscovery({ run, cwd: "/no-checkout" }) };
}

describe("GitHub repository discovery", () => {
  it("excludes inherited tokens from the actual CLI child for both authentication and work reads", async () => {
    const inheritedTokens = {
      GH_TOKEN: "fixture-public-primary",
      GITHUB_TOKEN: "fixture-public-fallback",
      GH_ENTERPRISE_TOKEN: "fixture-enterprise-primary",
      GITHUB_ENTERPRISE_TOKEN: "fixture-enterprise-fallback",
      github_enterprise_token: "fixture-windows-case-variant",
    };
    const child = createForgeCliRunner({
      binary: process.execPath,
      envOverlay: { ...inheritedTokens, FORGE_TEST_VISIBLE: "keep" },
      timeoutMs: 5_000,
      isAuthFailureText: () => false,
      errorClasses: {
        isAlreadyClassified: () => false,
        isCommandError: (error): error is ForgeCommandError => error instanceof ForgeCommandError,
        createAuthError: () => new Error("unexpected authentication failure"),
        createMissingError: () => new Error("missing node"),
        createCommandError: (params) =>
          new ForgeCommandError({ brand: "test", binary: "node" }, params),
      },
    });
    const childEnvironments: unknown[] = [];
    const responses = workResponses();
    const discovery = createGitHubRepositoryDiscovery({
      run: async (_args, options) => {
        const result = await child.run(
          [
            "-e",
            `
          const tokens = ${JSON.stringify(Object.keys(inheritedTokens))};
          process.stdout.write(JSON.stringify({
            presentTokenKeys: tokens.filter((key) => Object.hasOwn(process.env, key)),
            host: process.env.GH_HOST,
            kept: process.env.FORGE_TEST_VISIBLE,
          }));
        `,
          ],
          options,
        );
        childEnvironments.push(JSON.parse(result.stdout));
        return { stdout: JSON.stringify(responses.shift()), stderr: "" };
      },
    });
    await discovery.searchWork({
      repository: { ...identity, host: "ghe.acme.test" },
      kind: "issue",
    });
    expect(childEnvironments).toEqual([
      { presentTokenKeys: [], host: "ghe.acme.test", kept: "keep" },
      { presentTokenKeys: [], host: "ghe.acme.test", kept: "keep" },
      { presentTokenKeys: [], host: "ghe.acme.test", kept: "keep" },
    ]);
  });

  it("lists the host user's repositories with a bounded next page and no checkout", async () => {
    const { discovery, calls } = fixture([
      {},
      {
        data: {
          viewer: {
            repositories: {
              nodes: [repository],
              pageInfo: { hasNextPage: true, endCursor: "page-2" },
            },
          },
        },
      },
    ]);
    expect(
      await discovery.searchRepositories({ forge: "github", host: "github.com", limit: 2 }),
    ).toEqual({
      items: [
        {
          forge: "github",
          host: "github.com",
          id: "R_selected",
          fullName: "acme/project",
          url: repository.url,
          cloneUrl: repository.url,
          sshUrl: repository.sshUrl,
          visibility: "private",
          archived: false,
          updatedAt: repository.updatedAt,
        },
      ],
      nextCursor: "page-2",
    });
    expect(calls[0].args).toEqual(["auth", "status", "--active", "--hostname", "github.com"]);
    expect(calls[1].args).toContain("limit=2");
    expect(calls[1].args.join(" ")).toContain("ORGANIZATION_MEMBER");
    expect(calls.map(({ cwd }) => cwd)).toEqual(["/no-checkout", "/no-checkout"]);
  });

  it("searches forks and forwards the cursor as a separate GraphQL variable", async () => {
    const { discovery, calls } = fixture([
      {},
      { data: { search: { nodes: [repository], pageInfo: lastPage } } },
    ]);
    await discovery.searchRepositories({ ...identity, query: "acme", cursor: "next", limit: 1 });
    expect(calls[1].args.filter((arg) => arg.startsWith("query="))).toHaveLength(1);
    expect(calls[1].args).toContain("searchQuery=acme fork:true");
    expect(calls[1].args).toContain("cursor=next");
  });

  it("resolves the stable ID before searching only the selected repository", async () => {
    const { discovery, calls } = fixture(workResponses());
    expect(
      await discovery.searchWork({
        repository: identity,
        kind: "issue",
        query: "label:enhancement",
        limit: 1,
        cursor: "next",
      }),
    ).toEqual({
      items: [
        {
          repository: identity,
          id: work.id,
          kind: "issue",
          number: 131,
          title: work.title,
          url: work.url,
          state: "open",
          body: work.body,
          bodyTruncated: false,
          labels: ["enhancement"],
          updatedAt: work.updatedAt,
        },
      ],
      nextCursor: null,
    });
    expect(calls[1].args).toContain("id=R_selected");
    expect(calls[2].args).toContain(
      "searchQuery=repo:acme/project is:issue is:open label:enhancement",
    );
    expect(calls[2].args).toContain("cursor=next");
  });

  it("reads merged pull requests as closed work without changing their native state", async () => {
    const { discovery } = fixture(
      workResponses({ ...work, __typename: "PullRequest", state: "MERGED" }),
    );
    const page = await discovery.searchWork({
      repository: identity,
      kind: "change_request",
      state: "closed",
    });
    expect(page.items.map(({ kind, state }) => ({ kind, state }))).toEqual([
      { kind: "change_request", state: "merged" },
    ]);
  });

  it("bounds multibyte body text without splitting UTF-8", async () => {
    const { discovery } = fixture(workResponses({ ...work, body: "🦊".repeat(9_000) }));
    const page = await discovery.searchWork({ repository: identity, kind: "issue" });
    expect(page.items[0].body).toBe("🦊".repeat(8192));
    expect(page.items[0].bodyTruncated).toBe(true);
  });

  it("refuses results from another repository even if search qualifiers widen GitHub results", async () => {
    const { discovery } = fixture(workResponses({ ...work, repository: { id: "R_other" } }));
    await expect(
      discovery.searchWork({ repository: identity, kind: "issue", query: "repo:other/repo" }),
    ).rejects.toMatchObject({ code: "invalid_query" });
  });

  it("stops after a deleted or inaccessible repository lookup", async () => {
    const { discovery, calls } = fixture([{}, { data: { node: null } }]);
    await expect(
      discovery.searchWork({ repository: identity, kind: "issue" }),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(calls).toHaveLength(2);
  });

  it("routes every request to the authenticated Enterprise host", async () => {
    const { discovery, calls } = fixture(workResponses());
    await discovery.searchWork({
      repository: { ...identity, host: "GHE.Acme.test" },
      kind: "issue",
    });
    expect(
      calls.map(({ args, envOverlay }) => [
        args[args.indexOf("--hostname") + 1],
        envOverlay?.GH_HOST,
      ]),
    ).toEqual([
      ["ghe.acme.test", "ghe.acme.test"],
      ["ghe.acme.test", "ghe.acme.test"],
      ["ghe.acme.test", "ghe.acme.test"],
    ]);
  });

  it("never sends an API request when the selected host is not authenticated", async () => {
    const failure = Object.assign(new Error("gh auth login required"), {
      code: 1,
      stderr: "not logged into any github hosts",
    });
    const { discovery, calls } = fixture([failure]);
    await expect(
      discovery.searchRepositories({ forge: "github", host: "ghe.acme.test" }),
    ).rejects.toMatchObject({ code: "unauthenticated" });
    expect(calls).toHaveLength(1);
  });

  it.each([
    { failure: Object.assign(new Error("missing gh"), { code: "ENOENT" }), code: "cli_missing" },
    {
      failure: Object.assign(new Error("CLI failed"), {
        code: 1,
        stderr: "API rate limit exceeded",
      }),
      code: "rate_limited",
    },
    {
      failure: Object.assign(new Error("CLI failed"), { code: 1, stderr: "private-token-secret" }),
      code: "provider_error",
    },
  ])("returns $code without exposing raw CLI diagnostics", async ({ failure, code }) => {
    const { discovery } = fixture([failure]);
    await expect(discovery.searchRepositories(identity)).rejects.toMatchObject({ code });
  });

  it("rejects an incomplete GraphQL response instead of presenting an empty catalog", async () => {
    const { discovery } = fixture([
      {},
      { data: { viewer: null }, errors: [{ message: "secret diagnostic" }] },
    ]);
    await expect(discovery.searchRepositories(identity)).rejects.toMatchObject({
      code: "provider_error",
      message: "GitHub returned incomplete discovery data. Retry the request.",
    });
  });

  it("classifies malformed provider fields as provider errors rather than invalid requests", async () => {
    const { discovery } = fixture([
      {},
      { data: { viewer: { repositories: { nodes: null, pageInfo: lastPage } } } },
    ]);
    await expect(discovery.searchRepositories(identity)).rejects.toMatchObject({
      code: "provider_error",
    });
  });

  it.each([
    { ...identity, host: "https://github.com" },
    { ...identity, host: "github.com/other" },
    { ...identity, limit: 51 },
    { ...identity, cursor: "x".repeat(2049) },
  ])("rejects invalid routing and bounds before invoking gh", async (input) => {
    const { discovery, calls } = fixture([]);
    await expect(discovery.searchRepositories(input)).rejects.toThrow();
    expect(calls).toEqual([]);
  });
});
