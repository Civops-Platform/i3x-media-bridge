// Enough of MediaMTX's v3 control API and playback server to test the client
// against: path add/patch/get, /list and /get. Every request must carry the
// gateway's Basic credentials. Synthetic data only.

import { createServer, type Server } from "node:http";

export interface FakeState {
  paths: Map<string, { source: string; ready: boolean; bytesReceived: number; readers: number; tracks: string[] }>;
  recordings: Array<{ start: string; duration: number }>;
  gets: string[];
  listMisses: number;
}

export async function fakeMediaMtx(user: string, pass: string): Promise<{ url: string; state: FakeState; close: () => Promise<void> }> {
  const state: FakeState = { paths: new Map(), recordings: [], gets: [], listMisses: 0 };
  const want = "Basic " + Buffer.from(`${user}:${pass}`).toString("base64");
  const srv: Server = createServer((req, res) => {
    if (req.headers.authorization !== want) { res.writeHead(401).end("unauthorized"); return; }
    const u = new URL(req.url!, "http://x");
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const json = (code: number, j: unknown) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(j)); };
      let m: RegExpExecArray | null;
      if (req.method === "POST" && (m = /^\/v3\/config\/paths\/add\/(.+)$/.exec(u.pathname))) {
        const name = decodeURIComponent(m[1]);
        if (state.paths.has(name)) { res.writeHead(400).end(JSON.stringify({ error: "path already exists" })); return; }
        state.paths.set(name, { source: JSON.parse(body).source, ready: false, bytesReceived: 0, readers: 0, tracks: [] });
        return json(200, {});
      }
      if (req.method === "PATCH" && (m = /^\/v3\/config\/paths\/patch\/(.+)$/.exec(u.pathname))) {
        const p = state.paths.get(decodeURIComponent(m[1]));
        if (!p) return json(404, { error: "not found" });
        p.source = JSON.parse(body).source;
        return json(200, {});
      }
      if (req.method === "GET" && (m = /^\/v3\/paths\/get\/(.+)$/.exec(u.pathname))) {
        const p = state.paths.get(decodeURIComponent(m[1]));
        if (!p) return json(404, { error: "path not found" });
        return json(200, { ready: p.ready, bytesReceived: p.bytesReceived, readers: Array.from({ length: p.readers }, () => ({})), tracks: p.tracks });
      }
      if (u.pathname === "/list") {
        if (state.listMisses > 0) { state.listMisses--; return json(200, []); }
        return json(200, state.recordings);
      }
      if (u.pathname === "/get") {
        state.gets.push(u.search);
        res.writeHead(200, { "content-type": "video/mp4" });
        res.end(Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypisom"), Buffer.alloc(12)]));
        return;
      }
      res.writeHead(404).end();
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const port = (srv.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}`, state, close: () => new Promise((r) => srv.close(() => r())) };
}
