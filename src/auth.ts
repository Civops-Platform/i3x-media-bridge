// The gateway's auth hook. MediaMTX (authMethod: http) asks about every viewer,
// publisher and API caller; the answer is:
//
//   - the i3X server itself, with the gateway credentials: API, playback, read, metrics
//   - a viewer: read only, with a valid signed token for that exact path
//   - anyone publishing: never. Devices are pulled by the gateway, not pushed to.

import type { IncomingMessage, ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import type { ViewerTokens } from "./tokens";

export interface AuthRequest { user?: string; password?: string; action?: string; path?: string; query?: string }
export type AuthDecision = { allow: true } | { allow: false; reason: string };

const same = (a: string | undefined, b: string) => {
  const x = Buffer.from(a ?? ""), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

export function decide(a: AuthRequest, o: { user: string; pass: string; tokens: ViewerTokens }): AuthDecision {
  if (same(a.user, o.user) && same(a.password, o.pass) && ["api", "playback", "read", "metrics"].includes(a.action ?? "")) return { allow: true };
  if (a.action === "read") {
    const token = new URLSearchParams(a.query ?? "").get("token");
    if (a.path && o.tokens.verify(a.path, token)) return { allow: true };
    return { allow: false, reason: "a viewer needs the signed token from the stream's viewerUrl" };
  }
  return { allow: false, reason: `${a.action ?? "unknown"} is not allowed: devices are pulled by the gateway, never pushed to` };
}

/** A node:http handler for MediaMTX's authHTTPAddress. 200 allows, 401 denies. */
export function authHandler(o: { user: string; pass: string; tokens: ViewerTokens }) {
  return (req: IncomingMessage, res: ServerResponse) => {
    const deny = (why: string) => { res.writeHead(401, { "content-type": "text/plain" }); res.end(why); };
    if (req.method !== "POST") return deny("POST only");
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => { size += c.length; if (size > 64 * 1024) { req.destroy(); return; } chunks.push(c); });
    req.on("end", () => {
      let a: AuthRequest;
      try { a = JSON.parse(Buffer.concat(chunks).toString() || "{}"); } catch { return deny("bad request"); }
      const d = decide(a, o);
      if (d.allow) { res.writeHead(200).end(); return; }
      deny(d.reason);
    });
  };
}
