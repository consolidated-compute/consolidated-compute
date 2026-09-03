export function normalizeHubUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Hub URL must use HTTP or HTTPS");
  }
  if (url.username || url.password) {
    throw new Error("Hub URL cannot include credentials");
  }
  if (url.search || url.hash) {
    throw new Error("Hub URL cannot include a query or fragment");
  }
  url.pathname = url.pathname.replace(/\/$/, "");
  return url.toString().replace(/\/$/, "");
}
