/**
 * Same-origin CSRF check for POST/PUT/DELETE/PATCH endpoints.
 *
 * We don't issue a CSRF token because:
 *   * the session cookie is SameSite=strict — browsers won't attach
 *     it cross-site, which already blocks the canonical CSRF vector.
 *   * adding belt-and-braces same-origin validation costs ~5 lines
 *     and catches accidents (proxied dev setups, mis-CORSed reverse
 *     proxies) that SameSite alone doesn't.
 *
 * Origin is preferred over Referer (more reliable). If neither is
 * present we fail closed.
 *
 * `expectedHost` is taken from the `host` header (or
 * `x-forwarded-host` when behind a proxy) — NOT `req.url`. Next 15
 * synthesises req.url from the server's bind address (e.g.
 * `http://0.0.0.0:3000/...`) which doesn't match the client-facing
 * host, producing false-positive CSRF rejections.
 */
import type { NextRequest } from "next/server";

function _hostFromUrl(u: string | null | undefined): string | null {
  if (!u) return null;
  try { return new URL(u).host; } catch { return null; }
}

function _expectedHost(req: Request | NextRequest): string | null {
  const xfh = req.headers.get("x-forwarded-host");
  if (xfh) return xfh.split(",")[0]!.trim();
  const host = req.headers.get("host");
  if (host) return host;
  try { return new URL((req as Request).url).host; } catch { return null; }
}

export function validateSameOrigin(req: Request | NextRequest): boolean {
  const expectedHost = _expectedHost(req);
  if (!expectedHost) return false;
  const origin = _hostFromUrl(req.headers.get("origin"));
  if (origin) return origin === expectedHost;
  const referer = _hostFromUrl(req.headers.get("referer"));
  if (referer) return referer === expectedHost;
  return false;
}
