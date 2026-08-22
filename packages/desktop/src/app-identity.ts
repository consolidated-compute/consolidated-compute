import path from "node:path";

export const APP_DISPLAY_NAME = "Consolidated Compute";
export const COMPATIBILITY_USER_DATA_DIRECTORY = "Paseo";

export function resolveCompatibilityUserDataPath(appDataPath: string): string {
  return path.join(appDataPath, COMPATIBILITY_USER_DATA_DIRECTORY);
}
