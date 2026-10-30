// Next may reconstruct request.url with its internal hostname. HTTP Host remains
// the browser-facing authority; forwarding headers are not trusted here.
export function isSameOriginRequest(request) {
  if (request.headers.get("sec-fetch-site") === "cross-site") return false;
  const origin = request.headers.get("origin");
  if (!origin) return true; // Non-browser authenticated admin clients need no Origin.
  try {
    const incoming = new URL(origin);
    if (!["http:", "https:"].includes(incoming.protocol) || incoming.origin !== origin) return false;
    const internal = new URL(request.url);
    const host = request.headers.get("host");
    const effective = new URL(`${internal.protocol}//${host || internal.host}`);
    // Reject malformed authority rather than allowing URL parsing to discard it.
    if (host && (/[\s/\\?#@]/.test(host) || effective.username || effective.password || effective.pathname !== "/" || effective.search || effective.hash)) return false;
    if (incoming.origin === effective.origin) return true;
    // TLS termination may leave an internal HTTP URL. Only explicitly configured
    // public origins can authorize that scheme change, and Host must still match.
    return [process.env.BASE_URL, process.env.NEXT_PUBLIC_BASE_URL].some((value) => {
      if (!value) return false;
      try {
        const canonical = new URL(value);
        return ["http:", "https:"].includes(canonical.protocol) && !canonical.username && !canonical.password
          && canonical.host === effective.host && incoming.origin === canonical.origin;
      } catch { return false; }
    });
  } catch { return false; }
}
