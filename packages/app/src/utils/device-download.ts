export class DeviceDownloadError extends Error {
  constructor(
    readonly code: "invalid_credential" | "http_error" | "missing_body",
    readonly status?: number,
  ) {
    super(`Device download failed: ${code}${status === undefined ? "" : ` (${status})`}`);
    this.name = "DeviceDownloadError";
  }
}

export async function fetchDeviceDownload(
  url: string,
  credential: string,
  fetcher: (
    url: string,
    init: Pick<RequestInit, "headers" | "redirect" | "credentials" | "cache" | "referrerPolicy">,
  ) => Promise<Response>,
): Promise<Response> {
  if (!/^cc_device_[A-Za-z0-9_-]{43}$/.test(credential)) {
    throw new DeviceDownloadError("invalid_credential");
  }
  const response = await fetcher(url, {
    headers: { Authorization: `Bearer ${credential}` },
    redirect: "error",
    credentials: "omit",
    cache: "no-store",
    referrerPolicy: "no-referrer",
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new DeviceDownloadError("http_error", response.status);
  }
  return response;
}

export async function streamDeviceDownload(
  response: Response,
  target: WritableStream<Uint8Array>,
  onProgress: (written: number, total: number) => void,
): Promise<void> {
  if (!response.body) {
    const error = new DeviceDownloadError("missing_body");
    await target.abort(error);
    throw error;
  }
  const total = Number(response.headers.get("content-length") ?? 0);
  let written = 0;
  await response.body
    .pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          written += chunk.byteLength;
          onProgress(written, total);
          controller.enqueue(chunk);
        },
      }),
    )
    .pipeTo(target);
}
import type { File } from "expo-file-system";

export interface DeviceDownloadOptions {
  url: string;
  credential: string;
  fileName: string;
  mimeType: string | null;
  createTarget: () => File;
  onProgress: (written: number, total: number) => void;
}
