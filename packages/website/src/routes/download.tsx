import { createFileRoute, redirect } from "@tanstack/react-router";
import { CC_DISTRIBUTION_HREF } from "~/site-identity";

interface DownloadSearch {
  channel?: "beta";
}

export const Route = createFileRoute("/download")({
  validateSearch: (search: Record<string, unknown>): DownloadSearch =>
    search.channel === "beta" ? { channel: "beta" } : {},
  // Client-side links take the same path as the server's download redirect.
  beforeLoad: () => {
    throw redirect({ href: CC_DISTRIBUTION_HREF, replace: true });
  },
});
