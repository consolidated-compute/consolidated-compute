import { infiniteQueryOptions } from "@tanstack/react-query";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type {
  ForgeRepositoryIdentity,
  ForgeRepositoryWorkSearchInput,
} from "@getpaseo/protocol/forge-repositories";

type DiscoveryClient = Pick<DaemonClient, "searchForgeRepositories" | "searchForgeRepositoryWork">;

interface RepositoryQueryInput {
  client: DiscoveryClient | null;
  serverId: string;
  site: string;
  query: string;
  enabled: boolean;
}

export function repositoryQueryOptions(input: RepositoryQueryInput) {
  return infiniteQueryOptions({
    queryKey: ["github-work", input.serverId, "repositories", input.site, input.query] as const,
    enabled: input.enabled,
    initialPageParam: null as string | null,
    retry: false,
    refetchOnWindowFocus: false,
    queryFn: async ({ pageParam }) => {
      if (!input.client) throw new Error("Host is offline");
      return input.client.searchForgeRepositories({
        forge: "github",
        host: input.site,
        query: input.query,
        limit: 25,
        ...(pageParam ? { cursor: pageParam } : {}),
      });
    },
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
}

interface WorkQueryInput extends Omit<RepositoryQueryInput, "site"> {
  repository: ForgeRepositoryIdentity | null;
  kind: ForgeRepositoryWorkSearchInput["kind"];
  state: NonNullable<ForgeRepositoryWorkSearchInput["state"]>;
}

export function workQueryOptions(input: WorkQueryInput) {
  const repository = input.repository
    ? { forge: input.repository.forge, host: input.repository.host, id: input.repository.id }
    : null;
  return infiniteQueryOptions({
    queryKey: [
      "github-work",
      input.serverId,
      "work",
      repository,
      input.kind,
      input.state,
      input.query,
    ] as const,
    enabled: input.enabled && repository !== null,
    initialPageParam: null as string | null,
    retry: false,
    refetchOnWindowFocus: false,
    queryFn: async ({ pageParam }) => {
      if (!input.client || !repository) throw new Error("Select a repository on an online host");
      return input.client.searchForgeRepositoryWork({
        repository,
        kind: input.kind,
        state: input.state,
        query: input.query,
        limit: 25,
        ...(pageParam ? { cursor: pageParam } : {}),
      });
    },
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
}
