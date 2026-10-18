import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { RigRepository } from "../src/domain/rig-repository.js";
import { T3AgentBridge, type T3SessionClient } from "../src/integrations/t3-agent-bridge.js";
import { t3IntegrationRoutes } from "../src/routes/t3-integration.js";

const sessionId = "550e8400-e29b-41d4-a716-446655440000";
const fakeRepo = {
  listRigs: () => [{ id: "rig-1", name: "Wartribes" }],
  getRig: () => ({
    nodes: [
      { id: "node-1", logicalId: "builder", label: "Combat builder", role: "builder" },
      { id: "node-2", logicalId: "reviewer", label: "Reviewer", role: "reviewer" },
    ],
  }),
} as unknown as Pick<RigRepository, "listRigs" | "getRig">;

const dirs: string[] = [];
function harness() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "openrig-t3-"));
  dirs.push(home);
  const calls: Record<string, unknown>[] = [];
  let error: Error | null = null;
  const client: T3SessionClient = {
    request: async input => {
      calls.push(input);
      if (error) throw error;
      switch (input.action) {
        case "list": return { sessions: [{ id: sessionId, title: "Combat", status: "done_or_idle", project: "Wartribes" }] };
        case "send": return { delivered: true };
        case "read": return { messages: [{ role: "assistant", text: "Done" }] };
      }
      throw new Error("unsupported");
    },
  };
  return { home, calls, client, bridge: new T3AgentBridge(fakeRepo, client, home),
    setError: (value: Error | null) => { error = value; } };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("T3 integration — browser session seats", () => {
  it("binds only existing sessions and preserves identity across bridge construction", async () => {
    const { home, client, bridge, calls } = harness();
    await expect(bridge.bind("missing", sessionId)).rejects.toMatchObject({ status: 404 });
    await expect(bridge.bind("node-1", "unavailable-session")).rejects.toMatchObject({ status: 404 });
    await bridge.bind("node-1", sessionId);
    await expect(bridge.bind("node-2", sessionId)).rejects.toMatchObject({ status: 409 });
    const reopened = new T3AgentBridge(fakeRepo, client, home);
    const data = await reopened.agents();
    expect(data.agents[0]).toMatchObject({ id: "node-1", name: "Combat builder", status: "done_or_idle",
      binding: { nodeId: "node-1", sessionId } });
    expect(data.agents[1]).toMatchObject({ id: "node-2", status: "unbound" });
    await reopened.send("node-1", "Please proceed");
    expect(calls.at(-1)).toEqual({ action: "send", sessionId, message: "Please proceed" });
    expect(await reopened.messages("node-1")).toEqual({ messages: [{ role: "assistant", text: "Done" }] });
    expect(reopened.unbind("node-1")).toEqual({ unbound: true });
    expect(reopened.unbind("node-1")).toEqual({ unbound: false });
  });

  it("does not claim a missing/offline T3 session is working", async () => {
    const { bridge, setError } = harness();
    await bridge.bind("node-1", sessionId);
    setError(new Error("T3 desktop unavailable"));
    const summary = await bridge.agents();
    expect(summary).toMatchObject({ t3Online: false, t3Error: "T3 desktop unavailable" });
    expect(summary.agents[0]?.status).toBe("t3_offline");
    await expect(bridge.send("node-1", "message")).rejects.toThrow("T3 desktop unavailable");
  });

  it("protects binding and send endpoints with bearer credentials", async () => {
    const { home, client } = harness();
    const app = t3IntegrationRoutes(fakeRepo, { home, client, bearerToken: "test-secret" });
    const denied = await app.request("/agents/node-1/bind", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId }),
    });
    expect(denied.status).toBe(401);
    const authorized = await app.request("/agents/node-1/bind", {
      method: "POST", headers: { "content-type": "application/json", authorization: "Bearer test-secret" },
      body: JSON.stringify({ sessionId }),
    });
    expect(authorized.status).toBe(200);
    const response = await app.request("/agents", { headers: { authorization: "Bearer test-secret" } });
    expect(response.status).toBe(200);
    expect(((await response.json()) as {agents: Array<{binding: {sessionId: string}}>}).agents[0]?.binding.sessionId).toBe(sessionId);
    const sent = await app.request("/agents/node-1/send", {
      method: "POST", headers: { "content-type": "application/json", authorization: "Bearer test-secret" },
      body: JSON.stringify({ message: "Continue" }),
    });
    expect(sent.status).toBe(200);
  });
});

