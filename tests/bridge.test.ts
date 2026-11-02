// The bridge's pieces against a fake MediaMTX (tests/fake-mediamtx.ts). The real
// gateway, a real RTSP camera and real clips are in tests/e2e.test.ts.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { MediaMtxGateway, MediaMtxDriver, ViewerTokens, decide, authHandler, ClipCutter, isTripped, type DriverSink, type VQT } from "../src/index";
import { fakeMediaMtx } from "./fake-mediamtx";

const USER = "bridge", PASS = randomBytes(12).toString("hex");
const KEY = randomBytes(32);

function gatewayFor(url: string) {
  return new MediaMtxGateway({ id: "gw", kind: "mediamtx", apiUrl: url, playbackUrl: url, viewerBase: "http://gateway.example:8889" }, USER, PASS);
}

class Sink implements DriverSink {
  rows = new Map<string, VQT>();
  lostWhy: string | null = null;
  value(id: string, value: VQT["value"], quality: VQT["quality"], ts: string) { this.rows.set(id, { attributeId: id, value, quality, timestamp: ts }); }
  lost(why: string) { this.lostWhy = why; }
  restored() { this.lostWhy = null; }
}

test("viewer tokens: valid for their own path only, until they expire; tampering fails", () => {
  const t = new ViewerTokens(KEY);
  const now = Date.parse("2026-11-01T12:00:00Z");
  const tok = t.sign("line2-filler", now);
  assert.ok(t.verify("line2-filler", tok, now));
  assert.ok(!t.verify("dock-door", tok, now), "a token is for its own stream only");
  assert.ok(!t.verify("line2-filler", tok, now + 11 * 60_000), "expired");
  const [exp, sig] = tok.split(".");
  const flipped = sig.slice(0, 10) + (sig[10] === "A" ? "B" : "A") + sig.slice(11); // not the last char: its low bits are padding
  assert.ok(!t.verify("line2-filler", `${exp}.${flipped}`, now), "tampered signature");
  assert.ok(!t.verify("line2-filler", `${Number(exp) + 3600}.${sig}`, now), "extended expiry");
  assert.ok(!t.verify("line2-filler", null, now));
  assert.ok(!new ViewerTokens(randomBytes(32)).verify("line2-filler", tok, now), "another key");
  assert.throws(() => new ViewerTokens("short"), /32 bytes/);
});

test("viewer URL is stable within a minute", () => {
  const t = new ViewerTokens(KEY);
  const a = t.viewerUrl("http://gateway.example:8889", "line2-filler", Date.parse("2026-11-01T12:00:05Z"));
  const b = t.viewerUrl("http://gateway.example:8889", "line2-filler", Date.parse("2026-11-01T12:00:55Z"));
  const c = t.viewerUrl("http://gateway.example:8889", "line2-filler", Date.parse("2026-11-01T12:01:05Z"));
  assert.match(a, /^http:\/\/gateway\.example:8889\/line2-filler\/\?token=\d+\.[\w-]+$/);
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test("auth hook: the server's credentials, a viewer with a token, and nobody publishing", async () => {
  const tokens = new ViewerTokens(KEY);
  const o = { user: USER, pass: PASS, tokens };
  assert.deepEqual(decide({ user: USER, password: PASS, action: "api" }, o), { allow: true });
  assert.deepEqual(decide({ user: USER, password: PASS, action: "playback", path: "x" }, o), { allow: true });
  assert.equal(decide({ user: USER, password: "wrong", action: "api" }, o).allow, false);
  assert.equal(decide({ action: "read", path: "line2-filler", query: `token=${tokens.sign("line2-filler")}` }, o).allow, true);
  assert.equal(decide({ action: "read", path: "line2-filler" }, o).allow, false, "no token, no stream");
  assert.equal(decide({ action: "read", path: "dock-door", query: `token=${tokens.sign("line2-filler")}` }, o).allow, false);
  const pub = decide({ user: USER, password: PASS, action: "publish", path: "line2-filler" }, o);
  assert.equal(pub.allow, false, "not even the server's own credentials may publish");

  const srv = createServer(authHandler(o));
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(srv.address() as { port: number }).port}/auth`;
  try {
    const post = (b: unknown) => fetch(url, { method: "POST", body: JSON.stringify(b) }).then((r) => r.status);
    assert.equal(await post({ action: "read", path: "line2-filler", query: `token=${tokens.sign("line2-filler")}` }), 200);
    assert.equal(await post({ action: "publish", path: "line2-filler" }), 401);
    assert.equal(await fetch(url, { method: "POST", body: "{not json" }).then((r) => r.status), 401);
  } finally { srv.close(); }
});

test("ensurePath is idempotent; status reads health; an unknown path is null", async () => {
  const f = await fakeMediaMtx(USER, PASS);
  const gw = gatewayFor(f.url);
  try {
    await gw.ensurePath("line2-filler", "rtsp://camera.example:554/one");
    await gw.ensurePath("line2-filler", "rtsp://camera.example:554/two");
    assert.equal(f.state.paths.get("line2-filler")!.source, "rtsp://camera.example:554/two", "second call patches");
    Object.assign(f.state.paths.get("line2-filler")!, { ready: true, bytesReceived: 1000, readers: 2, tracks: ["H264"] });
    assert.deepEqual(await gw.status("line2-filler"), { ready: true, bytesReceived: 1000, readers: 2, tracks: ["H264"] });
    assert.equal(await gw.status("nope"), null);
    const bad = new MediaMtxGateway({ ...gw.cfg }, USER, "wrong");
    await assert.rejects(bad.ensurePath("x", "rtsp://camera.example/x"), /HTTP 401/);
  } finally { await f.close(); }
});

test("driver: online, bitrate from bytes between polls, viewers, tracks; a dark camera is a true offline; gateway gone → lost", async () => {
  const f = await fakeMediaMtx(USER, PASS);
  const gw = gatewayFor(f.url);
  await gw.ensurePath("line2-filler", "rtsp://camera.example/cam");
  await gw.ensurePath("dark", "rtsp://camera.example/none");
  Object.assign(f.state.paths.get("line2-filler")!, { ready: true, bytesReceived: 0, readers: 1, tracks: ["H264", "MPEG-4 Audio"] });
  const sink = new Sink();
  const fields = ["online", "bitrateKbps", "viewers", "tracks"];
  const points = [
    ...fields.map((f) => ({ attributeId: `cam/${f}`, binding: { source: "gw", address: `line2-filler#${f}` } })),
    { attributeId: "dark/online", binding: { source: "gw", address: "dark#online" } },
  ];
  let up = true;
  const d = new MediaMtxDriver({ id: "gw", options: { pollMs: 100 } }, () => (up ? gw : null));
  try {
    await d.start(points, sink);
    const feed = setInterval(() => { f.state.paths.get("line2-filler")!.bytesReceived += 6_250; }, 50); // ~1 Mbit/s
    await new Promise((r) => setTimeout(r, 350));
    clearInterval(feed);
    assert.equal(sink.rows.get("cam/online")!.value, true);
    const kbps = sink.rows.get("cam/bitrateKbps")!.value as number;
    assert.ok(kbps >= 250 && kbps <= 3000, `about 1000 kbps (timer jitter allowed), got ${kbps}`);
    assert.equal(sink.rows.get("cam/viewers")!.value, 1);
    assert.equal(sink.rows.get("cam/tracks")!.value, "H264,MPEG-4 Audio");
    assert.deepEqual([sink.rows.get("dark/online")!.value, sink.rows.get("dark/online")!.quality], [false, "Good"], "offline, as a true value");
    assert.equal(d.status().connected, true);
    up = false;
    await new Promise((r) => setTimeout(r, 250));
    assert.match(sink.lostWhy ?? "", /no gateway/);
    up = true;
    await new Promise((r) => setTimeout(r, 250));
    assert.equal(sink.lostWhy, null, "restored");
  } finally { await d.stop(); await f.close(); }
});

test("clip: window clamped to what was recorded; nothing recorded is a 404", async () => {
  const f = await fakeMediaMtx(USER, PASS);
  const gw = gatewayFor(f.url);
  try {
    f.state.recordings = [{ start: "2026-11-01T12:00:02.000Z", duration: 10 }];
    const bytes = await gw.clip("line2-filler", new Date("2026-11-01T12:00:00Z"), 6);
    assert.equal(bytes.subarray(4, 8).toString("latin1"), "ftyp");
    const q = new URLSearchParams(f.state.gets[0]);
    assert.equal(q.get("start"), "2026-11-01T12:00:02.000Z", "starts where the recording does");
    assert.equal(q.get("duration"), "4.000");
    await assert.rejects(gw.clip("line2-filler", new Date("2026-11-01T13:00:00Z"), 6), /HTTP 404 nothing recorded/);
  } finally { await f.close(); }
});

test("alarm → clip: a Good trip cuts once, waits out the open segment, and files a MediaItem; Bad or repeated values do not", async () => {
  const f = await fakeMediaMtx(USER, PASS);
  const gw = gatewayFor(f.url);
  const stored: Array<{ size: number; documents: string; capturedBy: string }> = [];
  const cutter = new ClipCutter(gw, [{ trigger: "alarm:high-temp", stream: "cam:line2-filler", path: "line2-filler", preS: 3, postS: 3 }],
    async (bytes, meta) => { stored.push({ size: bytes.length, documents: meta.documents, capturedBy: meta.capturedBy }); return `media:${meta.sha256}`; },
    { settleMs: 10, retryMs: 20 });
  try {
    const at = "2026-11-01T12:00:10.000Z";
    f.state.recordings = [{ start: "2026-11-01T12:00:00.000Z", duration: 30 }];
    f.state.listMisses = 2; // the segment is still open for the first two asks
    cutter.observe("alarm:high-temp", { attributeId: "alarm:high-temp/value", value: true, quality: "Bad", timestamp: at });
    cutter.observe("alarm:high-temp", { attributeId: "alarm:high-temp/value", value: "Active", quality: "Good", timestamp: at });
    cutter.observe("alarm:high-temp", { attributeId: "alarm:high-temp/value", value: true, quality: "Good", timestamp: at });
    const until = Date.now() + 3000;
    while (!cutter.results.length && Date.now() < until) await new Promise((r) => setTimeout(r, 20));
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(cutter.results.length, 1, "one trip, one clip");
    assert.ok("mediaId" in cutter.results[0], JSON.stringify(cutter.results[0]));
    assert.deepEqual(stored, [{ size: 24, documents: "alarm:high-temp", capturedBy: "cam:line2-filler" }]);
    assert.equal(new URLSearchParams(f.state.gets[0]).get("start"), "2026-11-01T12:00:07.000Z", "preS before the alarm");
    assert.equal(isTripped("CLEARED"), false);
    assert.equal(isTripped("Inactive"), false);
  } finally { await f.close(); }
});
