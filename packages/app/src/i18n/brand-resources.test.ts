import { describe, expect, it } from "vitest";
import { PRODUCT_DISPLAY_NAME } from "@/constants/product";
import { brandTranslationResources } from "./brand-resources";
import { i18n } from "./i18next";

describe("brandTranslationResources", () => {
  it("rebrands static upstream product references without mutating the source", () => {
    const source = {
      onboarding: { title: "Welcome to Paseo" },
      desktop: { quitting: ["Quitting Paseo...", "Stopping the local daemon."] },
    };

    expect(brandTranslationResources(source)).toEqual({
      onboarding: { title: `Welcome to ${PRODUCT_DISPLAY_NAME}` },
      desktop: { quitting: [`Quitting ${PRODUCT_DISPLAY_NAME}...`, "Stopping the local daemon."] },
    });
    expect(source.onboarding.title).toBe("Welcome to Paseo");
  });

  it("leaves interpolation placeholders and runtime values untouched", () => {
    const branded = brandTranslationResources({ project: 'Open "{{projectName}}" in Paseo' });

    expect(branded.project).toBe(`Open "{{projectName}}" in ${PRODUCT_DISPLAY_NAME}`);
    expect(branded.project.replace("{{projectName}}", "Paseo")).toBe(
      `Open "Paseo" in ${PRODUCT_DISPLAY_NAME}`,
    );
  });

  it("brands the resources registered with the app i18n instance", () => {
    expect(i18n.t("onboarding.title")).toBe(`Welcome to ${PRODUCT_DISPLAY_NAME}`);
    expect(i18n.t("desktop.quitting.title")).toBe(`Quitting ${PRODUCT_DISPLAY_NAME}...`);
  });
});
