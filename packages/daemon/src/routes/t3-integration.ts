import { Hono } from "hono";
import type { RigRepository } from "../domain/rig-repository.js";
import { authBearerTokenMiddleware } from "../middleware/auth-bearer-token.js";
import { T3AgentBridge, T3BridgeError, type T3SessionClient } from "../integrations/t3-agent-bridge.js";

/** Opt-in integration endpoints. The ordinary OpenRig session routes stay unchanged. */
export function t3IntegrationRoutes(
  rigRepo: Pick<RigRepository, "listRigs" | "getRig">,
  opts: { bearerToken?: string | null; client?: T3SessionClient; home?: string } = {},
) {
  const router = new Hono();
  const bridge = new T3AgentBridge(rigRepo, opts.client, opts.home);
  router.use("*", authBearerTokenMiddleware({ expectedToken: opts.bearerToken ?? null }));

  const result = async (fn: () => Promise<unknown>) => {
    try {
      return { ok: true as const, data: await fn() };
    } catch (error) {
      return { ok: false as const, error: error instanceof Error ? error.message : String(error),
        status: error instanceof T3BridgeError ? error.status : 503 as const };
    }
  };

  router.get("/agents", async c => {
    const response = await result(() => bridge.agents());
    return response.ok ? c.json(response.data) : c.json({ error: response.error }, response.status);
  });
  router.get("/sessions", async c => {
    const response = await result(() => bridge.sessions());
    return response.ok ? c.json({ sessions: response.data }) : c.json({ error: response.error }, response.status);
  });
  router.get("/agents/:id/messages", async c => {
    const count = Number(c.req.query("count") ?? 5);
    const response = await result(() => bridge.messages(c.req.param("id"), Number.isFinite(count) ? count : 5));
    return response.ok ? c.json(response.data) : c.json({ error: response.error }, response.status);
  });
  router.post("/agents/:id/bind", async c => {
    const body = await c.req.json().catch(() => null) as { sessionId?: unknown } | null;
    if (typeof body?.sessionId !== "string") return c.json({ error: "sessionId is required" }, 400);
    const response = await result(() => bridge.bind(c.req.param("id"), body.sessionId as string));
    return response.ok ? c.json(response.data) : c.json({ error: response.error }, response.status);
  });
  router.delete("/agents/:id/bind", c => {
    try { return c.json(bridge.unbind(c.req.param("id"))); }
    catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) },
        error instanceof T3BridgeError ? error.status : 503);
    }
  });
  router.post("/agents/:id/send", async c => {
    const body = await c.req.json().catch(() => null) as { message?: unknown } | null;
    if (typeof body?.message !== "string") return c.json({ error: "message is required" }, 400);
    const response = await result(() => bridge.send(c.req.param("id"), body.message as string));
    return response.ok ? c.json(response.data) : c.json({ error: response.error }, response.status);
  });
  return router;
}
