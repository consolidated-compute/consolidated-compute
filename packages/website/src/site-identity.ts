export const CC_PRODUCT_NAME = "Consolidated Compute";
export const CC_REPOSITORY_URL = "https://github.com/consolidated-compute/consolidated-compute";

export function isCcPagePath(pathname: string): boolean {
  return (
    pathname === "/" ||
    pathname === "/docs" ||
    pathname === "/docs.md" ||
    pathname.startsWith("/docs/")
  );
}

export function docsSourceUrl(sourcePath: string): string {
  return `${CC_REPOSITORY_URL}/blob/main/${sourcePath}`;
}

export function docsPageMeta(title: string, description: string) {
  return ccPageMeta(`${title} - ${CC_PRODUCT_NAME} Docs`, description);
}

export function ccPageMeta(pageTitle: string, description: string) {
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
