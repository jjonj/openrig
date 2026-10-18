#!/usr/bin/env node
/** ChatGPT/OmniMCP-accessible OpenRig controller using the same T3 seat bindings
 * as the desktop UI. No daemon, tmux, or separate session parser required.
 * Input is one JSON object on stdin to avoid quoting issues for long prompts.
 * Usage: '{"action":"agents"}' | node --import tsx scripts/omni/control.mts
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createDb } from "../../packages/daemon/src/db/connection.js";
import { RigRepository } from "../../packages/daemon/src/domain/rig-repository.js";
import { T3AgentBridge } from "../../packages/daemon/src/integrations/t3-agent-bridge.js";

export async function runControl(
  input: Record<string, unknown>,
  home = process.env.OPENRIG_HOME || path.join(os.homedir(), ".openrig"),
) {
  const dbPath = path.join(home, "openrig.sqlite");
  if (!fs.existsSync(dbPath)) throw new Error("OpenRig database unavailable. Seed the topology first.");
  const db = createDb(dbPath);
  try {
    const bridge = new T3AgentBridge(new RigRepository(db), undefined, home);
    const nodeId = input.nodeId;
    const sessionId = input.sessionId;
    switch (input.action) {
      case "agents": return bridge.agents();
      case "sessions": return { sessions: await bridge.sessions() };
      case "bind":
        if (typeof nodeId !== "string" || typeof sessionId !== "string") throw new Error("bind requires nodeId and sessionId");
        return bridge.bind(nodeId, sessionId);
      case "unbind":
        if (typeof nodeId !== "string") throw new Error("unbind requires nodeId");
        return bridge.unbind(nodeId);
      case "messages":
        if (typeof nodeId !== "string") throw new Error("messages requires nodeId");
        return bridge.messages(nodeId, typeof input.count === "number" ? input.count : 5);
      case "send":
        if (typeof nodeId !== "string" || typeof input.message !== "string") throw new Error("send requires nodeId and message");
        return bridge.send(nodeId, input.message);
      default: throw new Error("action must be agents, sessions, bind, unbind, messages or send");
    }
  } finally {
    db.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"))) {
  const chunks: Buffer[] = [];
  process.stdin.on("data", chunk => chunks.push(Buffer.from(chunk)));
  process.stdin.on("end", async () => {
    try {
      const input = JSON.parse(Buffer.concat(chunks).toString("utf8").replace(/^\uFEFF/, "")) as Record<string, unknown>;
      console.log(JSON.stringify(await runControl(input)));
    } catch (error) {
      console.error(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
      process.exitCode = 1;
    }
  });
}
