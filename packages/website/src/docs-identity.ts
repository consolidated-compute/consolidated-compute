export const DOCS_PRODUCT_NAME = "Consolidated Compute";
export const DOCS_REPOSITORY_URL = "https://github.com/consolidated-compute/consolidated-compute";

export function isDocsPath(pathname: string): boolean {
  return pathname === "/docs" || pathname === "/docs.md" || pathname.startsWith("/docs/");
}

export function docsSourceUrl(sourcePath: string): string {
  return `${DOCS_REPOSITORY_URL}/blob/main/${sourcePath}`;
}

export function docsPageMeta(title: string, description: string) {
  const pageTitle = `${title} - ${DOCS_PRODUCT_NAME} Docs`;
  // CC has no published website origin yet. Do not canonicalize fork-only docs
  // to Paseo or advertise its social image as this product's preview.
  return {
    meta: [
      { title: pageTitle },
      { name: "description", content: description },
      { property: "og:title", content: pageTitle },
      { property: "og:description", content: description },
      { name: "twitter:title", content: pageTitle },
      { name: "twitter:description", content: description },
    ],
  };
}
