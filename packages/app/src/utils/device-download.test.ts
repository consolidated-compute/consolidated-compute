import { createServer } from "node:http";
import { once } from "node:events";
import { expect, test } from "vitest";
import { fetchDeviceDownload, streamDeviceDownload } from "./device-download";

const credential = `cc_device_${"a".repeat(43)}`;

test("a missing response body aborts the output before failing", async () => {
  let aborted = false;
  await expect(
    streamDeviceDownload(
      new Response(null),
      new WritableStream({
        abort() {
          aborted = true;
        },
      }),
      () => {},
    ),
  ).rejects.toMatchObject({ code: "missing_body" });
  expect(aborted).toBe(true);
});

test("downloads using the device header and refuses redirects and HTTP failures", async () => {
  const requests: Array<{ path: string | undefined; authorization: string | undefined }> = [];
  const server = createServer((req, res) => {
    requests.push({ path: req.url, authorization: req.headers.authorization });
    if (req.url === "/redirect") {
      res.writeHead(302, { Location: "/must-not-follow" });
      res.end();
      return;
    }
    if (req.url === "/denied") {
      res.writeHead(403);
      res.end("denied");
      return;
    }
    res.writeHead(200, { "Content-Length": "7" });
    res.end("payload");
  });
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing test server address");
    const origin = `http://127.0.0.1:${address.port}`;
    const response = await fetchDeviceDownload(`${origin}/file?token=one-time`, credential, fetch);
    expect(await response.text()).toBe("payload");
    await expect(fetchDeviceDownload(`${origin}/redirect`, credential, fetch)).rejects.toThrow();
    await expect(fetchDeviceDownload(`${origin}/denied`, credential, fetch)).rejects.toMatchObject({
      code: "http_error",
      status: 403,
    });
    await expect(fetchDeviceDownload(`${origin}/file`, "", fetch)).rejects.toMatchObject({
      code: "invalid_credential",
    });
    expect(requests).toEqual([
      { path: "/file?token=one-time", authorization: `Bearer ${credential}` },
      { path: "/redirect", authorization: `Bearer ${credential}` },
      { path: "/denied", authorization: `Bearer ${credential}` },
    ]);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }
});

test("streams exact bytes and reports cumulative progress without buffering the file", async () => {
  const chunks = [new Uint8Array([1, 2]), new Uint8Array([3, 4, 5])];
  const response = new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    }),
    { headers: { "Content-Length": "5" } },
  );
  const received: Uint8Array[] = [];
  const progress: number[][] = [];
  await streamDeviceDownload(
    response,
    new WritableStream({
      write(chunk) {
        received.push(chunk);
      },
    }),
    (written, total) => progress.push([written, total]),
  );
  expect(received).toEqual(chunks);
  expect(progress).toEqual([
    [2, 5],
    [5, 5],
  ]);
});

test("propagates a failed output write and cancels the response stream", async () => {
  let canceled = false;
  const response = new Response(
    new ReadableStream({
      pull(controller) {
        controller.enqueue(new Uint8Array([1]));
      },
      cancel() {
        canceled = true;
      },
    }),
  );
  await expect(
    streamDeviceDownload(
      response,
      new WritableStream({
        write() {
          throw new Error("disk full");
        },
      }),
      () => {},
    ),
  ).rejects.toThrow("disk full");
  expect(canceled).toBe(true);
});
