// Signed viewer tokens. An i3X read of a stream object hands out a `viewerUrl`
// carrying `?token=<exp>.<sig>`; the gateway's auth hook (./auth.ts) checks it. A
// token is for one stream path only, and expires.
//
// sig = HMAC-SHA256(key, "stream:<path>|get|<exp>"), base64url; exp in epoch seconds.

import { createHmac, timingSafeEqual } from "node:crypto";

export class ViewerTokens {
  constructor(private key: Buffer | string, private ttlMs = 10 * 60_000) {
    if (Buffer.byteLength(key) < 32) throw new Error("viewer token key: use at least 32 bytes");
  }

  private mac(path: string, exp: number) {
    return createHmac("sha256", this.key).update(`stream:${path}|get|${exp}`).digest();
  }

  sign(path: string, now = Date.now()): string {
    const exp = Math.floor((now + this.ttlMs) / 1000);
    return `${exp}.${this.mac(path, exp).toString("base64url")}`;
  }

  verify(path: string, token: string | null | undefined, now = Date.now()): boolean {
    const [exp, sig] = (token ?? "").split(".");
    if (!exp || !sig || !/^\d+$/.test(exp) || Number(exp) * 1000 < now) return false;
    const want = this.mac(path, Number(exp));
    const got = Buffer.from(sig, "base64url");
    return got.length === want.length && timingSafeEqual(got, want);
  }

  /**
   * The URL a viewer opens. Stable within a minute, so a client subscribed to the
   * stream object does not see a new value on every read.
   */
  viewerUrl(viewerBase: string, path: string, now = Date.now()): string {
    const bucket = Math.floor(now / 60_000) * 60_000;
    return `${viewerBase}/${path}/?token=${this.sign(path, bucket)}`;
  }
}
