#!/usr/bin/env node
/**
 * Phase-1 local-only HTTP bridge while OpenRig's native Windows/tmux-independent
 * daemon path is not yet available. Does NOT claim to run the full Rig daemon.
 * The full daemon owns this route when it runs; never start them together.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createServer } from "node:http";
import { Hono } from "hono";
import { createDb } from "../../packages/daemon/src/db/connection.js";
import { RigRepository } from "../../packages/daemon/src/domain/rig-repository.js";
import { t3IntegrationRoutes } from "../../packages/daemon/src/routes/t3-integration.js";

const home = process.env.OPENRIG_HOME ?? path.join(os.homedir(), ".openrig");
const port = Number(process.env.OPENRIG_T3_BRIDGE_PORT ?? "7433");
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Invalid bridge port");
const dbFile = path.join(home, "openrig.sqlite");
if (!fs.existsSync(dbFile)) throw new Error("OpenRig topology not seeded: " + dbFile);
const db = createDb(dbFile);
const app = new Hono();
app.get("/healthz", c => c.json({ ok: true, service: "openrig-t3-phase1-bridge", fullRigDaemon: false }));
app.route("/api/integrations/t3", t3IntegrationRoutes(new RigRepository(db), {
  bearerToken: process.env.OPENRIG_AUTH_BEARER_TOKEN ?? null,
  home,
}));
const server = createServer(async (req, res) => {
  try {
    const host = "127.0.0.1:" + port;
    const url = new URL(req.url ?? "/", "http://" + host);
    const parts: Uint8Array[] = [];
    let bytes = 0;
    for await (const part of req) {
      bytes += part.length;
      if (bytes > 64_000) { res.writeHead(413); res.end("body too large"); return; }
      parts.push(part);
    }
    const request = new Request(url, {
      method: req.method,
      headers: req.headers as HeadersInit,
      body: ["GET", "HEAD"].includes(req.method ?? "") ? undefined : Buffer.concat(parts),
    });
    const response = await app.fetch(request);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "OpenRig T3 bridge request failed" }));
    console.error(error);
  }
});
server.on("error", error => { console.error(error); db.close(); process.exitCode = 1; });
server.listen(port, "127.0.0.1", () =>
  console.log("OpenRig T3 Phase-1 bridge listening on 127.0.0.1:" + port + " (full daemon disabled)"),
);
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => server.close(() => db.close()));
