import { isDocsPath } from "./docs-identity";
import type { ReleaseChannels } from "./latest-release";

interface SiteDataSources {
  release: () => Promise<ReleaseChannels>;
  stars: () => Promise<{ stars: string }>;
}

export async function loadSiteData(pathname: string, sources: SiteDataSources) {
  // The docs are local content. Upstream marketing data must not gate a read.
  if (isDocsPath(pathname)) return { kind: "docs" as const };
  const [release, stars] = await Promise.all([sources.release(), sources.stars()]);
  return { kind: "upstream" as const, release, ...stars };
}
