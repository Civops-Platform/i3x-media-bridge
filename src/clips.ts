// Alarm → clip. When an alarm attribute trips, cut a clip from the gateway's
// recording around it and hand the bytes to the host's media store, which files it
// as a MediaItem that `Documents` the alarm and was `CapturedBy` the stream.

import { createHash } from "node:crypto";
import type { MediaMtxGateway } from "./gateway";
import type { VQT } from "./types";

export interface ClipRule {
  /** The alarm object's id; its value tripping cuts a clip. */
  trigger: string;
  /** The stream object's id, and its gateway path. */
  stream: string;
  path: string;
  preS: number;
  postS: number;
}

export interface ClipMeta {
  sha256: string; mimeType: "video/mp4"; size: number;
  capturedBy: string; documents: string; capturedAt: string; durationMs: number; description: string;
}

export type ClipResult = { trigger: string; mediaId: string; at: string } | { trigger: string; error: string; at: string };

/** true, or a status string that reads as active ("TRIPPED", "Active") and not as cleared. */
export const isTripped = (v: VQT["value"]) =>
  v === true || (typeof v === "string" && /trip|active|alarm|on/i.test(v) && !/clear|off|inactive/i.test(v));

export class ClipCutter {
  readonly results: ClipResult[] = [];
  private last = new Map<string, VQT["value"]>();

  constructor(
    private gw: MediaMtxGateway,
    private rules: ClipRule[],
    /** Store the bytes; return the new MediaItem's element id. */
    private store: (bytes: Buffer, meta: ClipMeta) => Promise<string>,
    private o: { retryMs?: number; retries?: number; settleMs?: number } = {},
  ) {}

  /** Feed every alarm value change here. A Good value that newly trips arms its rules. */
  observe(objectId: string, v: VQT) {
    if (v.quality !== "Good") return; // a doubtful reading neither trips nor resets an alarm
    const before = this.last.get(objectId);
    this.last.set(objectId, v.value);
    if (!isTripped(v.value) || isTripped(before ?? null)) return;
    const at = new Date(Date.parse(v.timestamp) || Date.now());
    for (const r of this.rules.filter((x) => x.trigger === objectId)) {
      // The recording after the alarm has to exist before it can be cut.
      setTimeout(() => void this.cut(r, at), this.o.settleMs ?? (r.postS + 2) * 1000).unref();
    }
  }

  async cut(r: ClipRule, at: Date): Promise<ClipResult> {
    const stamp = new Date().toISOString();
    let out: ClipResult;
    try {
      // The gateway serves a recording only once its segment has closed: retry a 404 for up to a minute.
      let bytes: Buffer | null = null;
      for (let i = 0; ; i++) {
        try { bytes = await this.gw.clip(r.path, new Date(at.getTime() - r.preS * 1000), r.preS + r.postS); break; }
        catch (e) { if (i >= (this.o.retries ?? 11) || !/HTTP 404/.test((e as Error).message)) throw e; await new Promise((x) => setTimeout(x, this.o.retryMs ?? 5_000)); }
      }
      const sha = createHash("sha256").update(bytes).digest("hex");
      const mediaId = await this.store(bytes, { sha256: sha, mimeType: "video/mp4", size: bytes.length, capturedBy: r.stream, documents: r.trigger,
        capturedAt: at.toISOString(), durationMs: (r.preS + r.postS) * 1000, description: `Clip around ${r.trigger}` });
      out = { trigger: r.trigger, mediaId, at: stamp };
    } catch (e) {
      out = { trigger: r.trigger, error: (e as Error).message, at: stamp };
    }
    this.results.push(out);
    return out;
  }
}
