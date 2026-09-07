import type { ReactNode } from "react";
import { createContext, useContext } from "react";
import { Outlet, createRootRoute, HeadContent, Scripts } from "@tanstack/react-router";
import type { ReleaseChannels, ReleaseInfo } from "~/latest-release";
import { getLatestRelease } from "~/release";
import { getStarCount } from "~/stars";
import { DOCS_PRODUCT_NAME } from "~/docs-identity";
import { loadSiteData } from "~/site-data";

interface StarsContext {
  stars: string;
}

const ReleaseCtx = createContext<ReleaseChannels>({
  stable: {
    version: "",
    linuxAppImageAsset: "",
    windowsX64Asset: null,
    windowsArm64Asset: null,
  },
  beta: null,
});
const StarsCtx = createContext<StarsContext>({ stars: "" });

const PLAUSIBLE_INIT_SCRIPT = {
  __html: `window.plausible=window.plausible||function(){(plausible.q=plausible.q||[]).push(arguments)},plausible.init=plausible.init||function(i){plausible.o=i||{}};plausible.init()`,
};

/** The latest stable release. Everything on the site points here by default. */
export function useRelease(): ReleaseInfo {
  return useContext(ReleaseCtx).stable;
}

/** The current beta, or null when there is no beta ahead of stable. */
export function useBetaRelease(): ReleaseInfo | null {
  return useContext(ReleaseCtx).beta;
}

export function useStars(): StarsContext {
  return useContext(StarsCtx);
}

export const Route = createRootRoute({
  loader: ({ location }) =>
    loadSiteData(location.pathname, { release: getLatestRelease, stars: getStarCount }),
  head: ({ loaderData }) => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { name: "theme-color", content: "#101615" },
      {
        property: "og:site_name",
        content: loaderData?.kind === "docs" ? DOCS_PRODUCT_NAME : "Paseo",
      },
      { property: "og:type", content: "website" },
      ...(loaderData?.kind === "docs"
        ? []
        : [
            { property: "og:image", content: "https://paseo.sh/og-image.png" },
            { name: "twitter:card", content: "summary_large_image" },
            { name: "twitter:image", content: "https://paseo.sh/og-image.png" },
          ]),
    ],
    links: [
      { rel: "icon", href: "/favicon.ico", sizes: "48x48" },
      { rel: "icon", href: "/favicon.svg", type: "image/svg+xml" },
      { rel: "apple-touch-icon", href: "/favicon.svg" },
    ],
  }),
  component: RootComponent,
});

function RootComponent() {
  const data = Route.useLoaderData();
  if (data.kind === "docs") {
    return (
      <RootDocument isDocs>
        <Outlet />
      </RootDocument>
    );
  }
  return (
    <ReleaseCtx value={data.release}>
      <StarsCtx value={data}>
        <RootDocument>
          <Outlet />
        </RootDocument>
      </StarsCtx>
    </ReleaseCtx>
  );
}

function RootDocument({
  children,
  isDocs = false,
}: Readonly<{ children: ReactNode; isDocs?: boolean }>) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
        {!isDocs && (
          <>
            <script async src="https://plausible.io/js/pa-cKNUoWbeH_Iksb2fh82s3.js" />
            <script dangerouslySetInnerHTML={PLAUSIBLE_INIT_SCRIPT} />
          </>
        )}
      </head>
      <body className="antialiased bg-background text-foreground">
        {children}
        <Scripts />
      </body>
    </html>
  );
}
