// Live video and audio for an i3X server, through MediaMTX (the open-source
// RTSP/WebRTC/HLS server).
//
// The bytes of a live stream never pass through the i3X API. The gateway pulls each
// camera or microphone and re-serves it to viewers. This client does the three
// things an i3X server needs from it:
//
//   1. Registers a path per stream object, pulling from the device's RTSP URL and
//      recording to a short rolling buffer (ensurePath).
//   2. Reads stream health: online, bytes received, viewers, tracks (status). The
//      `MediaMtxDriver` turns that into ordinary i3X values, so a camera going dark
//      is a quality change like any other.
//   3. Cuts a recorded clip around a moment (clip), for alarm → clip.
//
// Who may watch is decided in ./auth.ts, which MediaMTX calls for every request.

export interface GatewayConfig {
  id: string;
  kind: "mediamtx";
  apiUrl: string;
  playbackUrl: string;
  /** Base viewers use, e.g. http://gateway:8889 (WebRTC) */
  viewerBase: string;
}

export interface PathStatus { ready: boolean; bytesReceived: number; readers: number; tracks: string[] }

export class MediaMtxGateway {
  private auth: string;
  constructor(readonly cfg: GatewayConfig, readonly user: string, readonly pass: string) {
    this.auth = "Basic " + Buffer.from(`${user}:${pass}`).toString("base64");
  }

  private async api(method: string, path: string, body?: unknown) {
    return fetch(this.cfg.apiUrl + path, {
      method, signal: AbortSignal.timeout(5_000),
      headers: { authorization: this.auth, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  /** Create or replace the path that pulls this device. Idempotent. */
  async ensurePath(name: string, source: string) {
    const conf = { source, sourceOnDemand: false, record: true };
    let r = await this.api("POST", `/v3/config/paths/add/${encodeURIComponent(name)}`, conf);
    if (r.status === 400 && /already exists/i.test(await r.text())) r = await this.api("PATCH", `/v3/config/paths/patch/${encodeURIComponent(name)}`, conf);
    if (!r.ok) throw new Error(`gateway ${this.cfg.id}: cannot configure path ${name}: HTTP ${r.status} ${await r.text().catch(() => "")}`);
  }

  async status(name: string): Promise<PathStatus | null> {
    const r = await this.api("GET", `/v3/paths/get/${encodeURIComponent(name)}`);
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`gateway ${this.cfg.id}: HTTP ${r.status}`);
    const j = (await r.json()) as { ready?: boolean; bytesReceived?: number; readers?: unknown[]; tracks?: string[] };
    return { ready: !!j.ready, bytesReceived: j.bytesReceived ?? 0, readers: j.readers?.length ?? 0, tracks: j.tracks ?? [] };
  }

  /**
   * A recorded clip, fMP4, from the gateway's playback server. The requested window
   * is clamped to what was actually recorded (a recording starts when the device
   * comes up and has gaps when it drops); a window with no recording at all is a 404.
   */
  async clip(name: string, start: Date, durationS: number): Promise<Buffer> {
    const lr = await fetch(`${this.cfg.playbackUrl}/list?path=${encodeURIComponent(name)}`, { headers: { authorization: this.auth }, signal: AbortSignal.timeout(10_000) });
    if (!lr.ok) throw new Error(`gateway ${this.cfg.id}: clip ${name} HTTP ${lr.status} ${await lr.text().catch(() => "")}`);
    const spans = (await lr.json()) as Array<{ start: string; duration: number }>;
    const from = start.getTime(), to = from + durationS * 1000;
    const hit = spans
      .map((x) => ({ s: Date.parse(x.start), e: Date.parse(x.start) + x.duration * 1000 }))
      .filter((x) => x.e > from && x.s < to)
      .sort((x, y) => x.s - y.s)[0];
    if (!hit) throw new Error(`gateway ${this.cfg.id}: clip ${name} HTTP 404 nothing recorded between ${start.toISOString()} and ${new Date(to).toISOString()}`);
    const s0 = Math.max(from, hit.s), e0 = Math.min(to, hit.e);
    const u = `${this.cfg.playbackUrl}/get?path=${encodeURIComponent(name)}&start=${encodeURIComponent(new Date(s0).toISOString())}&duration=${((e0 - s0) / 1000).toFixed(3)}`;
    const r = await fetch(u, { headers: { authorization: this.auth }, signal: AbortSignal.timeout(30_000) });
    if (!r.ok) throw new Error(`gateway ${this.cfg.id}: clip ${name} HTTP ${r.status} ${await r.text().catch(() => "")}`);
    return Buffer.from(await r.arrayBuffer());
  }
}
