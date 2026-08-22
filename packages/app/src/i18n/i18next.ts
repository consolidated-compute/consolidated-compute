import { createInstance } from "i18next";
import { initReactI18next } from "react-i18next";
import { brandTranslationResources } from "./brand-resources";
import { observeI18nInit } from "./init";
import { ar } from "./resources/ar";
import { en } from "./resources/en";
import { es } from "./resources/es";
import { fr } from "./resources/fr";
import { ja } from "./resources/ja";
import { ko } from "./resources/ko";
import { ptBR } from "./resources/pt-BR";
import { ru } from "./resources/ru";
import { zhCN } from "./resources/zh-CN";

const i18n = createInstance();

observeI18nInit(
  i18n.use(initReactI18next).init({
    compatibilityJSON: "v4",
    fallbackLng: "en",
    lng: "en",
    resources: {
      ar: { translation: brandTranslationResources(ar) },
      en: { translation: brandTranslationResources(en) },
      es: { translation: brandTranslationResources(es) },
      fr: { translation: brandTranslationResources(fr) },
      ja: { translation: brandTranslationResources(ja) },
      ko: { translation: brandTranslationResources(ko) },
      "pt-BR": { translation: brandTranslationResources(ptBR) },
      ru: { translation: brandTranslationResources(ru) },
      "zh-CN": { translation: brandTranslationResources(zhCN) },
    },
    interpolation: {
      escapeValue: false,
    },
    react: {
      useSuspense: false,
    },
  }),
);

export { i18n };
