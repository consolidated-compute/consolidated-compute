import { fetchDeviceDownload, type DeviceDownloadOptions } from "./device-download";

export async function downloadWithDeviceCredential(input: DeviceDownloadOptions): Promise<void> {
  const response = await fetchDeviceDownload(input.url, input.credential, fetch);
  const blobUrl = URL.createObjectURL(await response.blob());
  try {
    const link = document.createElement("a");
    link.href = blobUrl;
    link.download = input.fileName;
    link.rel = "noopener";
    document.body.appendChild(link);
    try {
      link.click();
    } finally {
      link.remove();
    }
  } finally {
    // The browser must consume the click before its Blob is released.
    setTimeout(() => URL.revokeObjectURL(blobUrl), 60_000);
  }
}
