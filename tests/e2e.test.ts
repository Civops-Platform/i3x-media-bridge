// End to end against a real MediaMTX and a real RTSP camera (an ffmpeg test
// pattern). Runs only with I3X_TEST_GATEWAY=1; scripts/e2e-docker.sh sets up both
// from config/test/*.yml and tears them down.

import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { MediaMtxGateway, MediaMtxDriver, ViewerTokens, authHandler, ClipCutter, type DriverSink, type VQT } from "../src/index";

const skip = !process.env.I3X_TEST_GATEWAY && "no media gateway (run scripts/e2e-docker.sh)";

function rtspDescribe(url: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const s = net.connect(Number(u.port), u.hostname, () => s.write(`DESCRIBE ${url} RTSP/1.0\r\nCSeq: 1\r\nAccept: application/sdp\r\n\r\n`));
    let buf = "";
    s.on("data", (d) => { buf += d; const m = /^RTSP\/1\.0 (\d+)/.exec(buf); if (m) { s.destroy(); resolve(Number(m[1])); } });
    s.on("error", reject);
    setTimeout(() => { s.destroy(); reject(new Error("RTSP timeout")); }, 8000);
  });
}

async function until<T>(f: () => T | false | Promise<T | false>, ms: number): Promise<T> {
  const end = Date.now() + ms;
  for (;;) { const v = await f(); if (v) return v; if (Date.now() > end) throw new Error("timed out"); await new Promise((r) => setTimeout(r, 500)); }
}

test("real gateway: health as values, signed viewer access, no publishing, alarm → MP4 clip", { skip, timeout: 180_000 }, async () => {
  const user = "bridge", pass = randomBytes(16).toString("hex");
  const tokens = new ViewerTokens(randomBytes(32));
  const auth = createServer(authHandler({ user, pass, tokens }));
  await new Promise<void>((r) => auth.listen(8440, "127.0.0.1", r));
  const gw = new MediaMtxGateway({ id: "gw", kind: "mediamtx", apiUrl: "http://127.0.0.1:9997", playbackUrl: "http://127.0.0.1:9996", viewerBase: "http://127.0.0.1:8889" }, user, pass);
  const rows = new Map<string, VQT>();
  const sink: DriverSink = { value: (id, value, quality, timestamp) => rows.set(id, { attributeId: id, value, quality, timestamp }), lost: () => {}, restored: () => {} };
  const driver = new MediaMtxDriver({ id: "gw", options: { pollMs: 1000 } }, () => gw);
  try {
    await until(async () => { try { await gw.ensurePath("line2-filler", process.env.I3X_TEST_CAMERA ?? "rtsp://127.0.0.1:8654/cam"); return true; } catch { return false; } }, 20_000);
    await gw.ensurePath("dark", "rtsp://127.0.0.1:8655/none");
    await driver.start(["online", "bitrateKbps"].flatMap((f) => [
      { attributeId: `cam/${f}`, binding: { source: "gw", address: `line2-filler#${f}` } },
      { attributeId: `dark/${f}`, binding: { source: "gw", address: `dark#${f}` } },
    ]), sink);
    await until(() => rows.get("cam/online")?.value === true && (rows.get("cam/bitrateKbps")?.value as number) > 0, 30_000);
    assert.equal(rows.get("cam/online")!.quality, "Good");
    assert.equal(rows.get("dark/online")!.value, false, "a camera that sends nothing reads offline, as a true value");

    const token = new URL(tokens.viewerUrl("http://127.0.0.1:8889", "line2-filler")).searchParams.get("token");
    assert.equal(await rtspDescribe(`rtsp://127.0.0.1:8554/line2-filler?token=${token}`), 200, "the signed viewer token opens the stream");
    assert.equal(await rtspDescribe("rtsp://127.0.0.1:8554/line2-filler"), 401, "no token, no stream");
    assert.equal(await rtspDescribe(`rtsp://127.0.0.1:8554/dark?token=${token}`), 401, "a token is for its own stream only");

    // Recording needs some history before the alarm (preS) and a closed segment after it.
    await new Promise((r) => setTimeout(r, 8000));
    let clip: Buffer | null = null;
    const cutter = new ClipCutter(gw, [{ trigger: "alarm:high-temp", stream: "cam:line2-filler", path: "line2-filler", preS: 3, postS: 3 }],
      async (bytes, meta) => { clip = bytes; return `media:${meta.sha256}`; });
    cutter.observe("alarm:high-temp", { attributeId: "alarm:high-temp/value", value: true, quality: "Good", timestamp: new Date().toISOString() });
    const r = await until(() => cutter.results[0], 90_000);
    assert.ok("mediaId" in r, JSON.stringify(r));
    assert.equal(clip!.subarray(4, 8).toString("latin1"), "ftyp", "an MP4 clip");
    console.log(`# live bitrate ${rows.get("cam/bitrateKbps")!.value} kbps; clip ${clip!.length} bytes`);
  } finally {
    await driver.stop();
    auth.close();
  }
});
