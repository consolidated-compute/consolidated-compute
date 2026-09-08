import { fetch } from "expo/fetch";
import * as Sharing from "expo-sharing";
import { i18n } from "@/i18n/i18next";
import {
  fetchDeviceDownload,
  streamDeviceDownload,
  type DeviceDownloadOptions,
} from "./device-download";

export async function downloadWithDeviceCredential(input: DeviceDownloadOptions): Promise<void> {
  const target = input.createTarget();
  const response = await fetchDeviceDownload(input.url, input.credential, fetch);
  let created = false;
  try {
    target.create();
    created = true;
    await streamDeviceDownload(response, target.writableStream(), input.onProgress);
  } catch (error) {
    await response.body?.cancel().catch(() => undefined);
    if (created && target.exists) target.delete();
    throw error;
  }
  if (await Sharing.isAvailableAsync()) {
    await Sharing.shareAsync(target.uri, {
      mimeType: input.mimeType ?? undefined,
      dialogTitle: i18n.t("downloads.shareFileNamed", { fileName: input.fileName }),
    });
  }
}
