import { PRODUCT_DISPLAY_NAME } from "@/constants/product";

const UPSTREAM_PRODUCT_DISPLAY_NAME = "Paseo";

function brandTranslationValue(value: unknown): unknown {
  if (typeof value === "string") {
    return value.replaceAll(UPSTREAM_PRODUCT_DISPLAY_NAME, PRODUCT_DISPLAY_NAME);
  }

  if (Array.isArray(value)) {
    return value.map(brandTranslationValue);
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, brandTranslationValue(child)]),
    );
  }

  return value;
}

export function brandTranslationResources<T>(resources: T): T {
  return brandTranslationValue(resources) as T;
}
