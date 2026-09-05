import type {
  ForgeRepositoryPage,
  ForgeRepositorySearchInput,
  ForgeRepositoryWorkPage,
  ForgeRepositoryWorkSearchInput,
} from "@getpaseo/protocol/forge-repositories";

export interface ForgeRepositoryDiscovery {
  searchRepositories(input: ForgeRepositorySearchInput): Promise<ForgeRepositoryPage>;
  searchWork(input: ForgeRepositoryWorkSearchInput): Promise<ForgeRepositoryWorkPage>;
}

export class ForgeRepositoryDiscoveryError extends Error {
  constructor(
    readonly code:
      | "unsupported"
      | "unauthenticated"
      | "cli_missing"
      | "rate_limited"
      | "not_found"
      | "invalid_query"
      | "provider_error",
    message: string,
  ) {
    super(message);
    this.name = "ForgeRepositoryDiscoveryError";
  }
}
