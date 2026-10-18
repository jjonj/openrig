import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { RigRepository } from "../domain/rig-repository.js";

export interface T3BrowserSession {
  id: string;
  title: string;
  project?: string | null;
  status?: string;
  statusReason?: string;
  parentSessionId?: string | null;
  uiColor?: string;
}

export interface T3SessionClient {
  request(input: Record<string, unknown>): Promise<unknown>;
}

export interface T3AgentBinding {
  nodeId: string;
  sessionId: string;
  boundAt: string;
}

/**
 * OpenRig owns seats. T3 owns conversation history and delivery.
 * This adapter deliberately neither creates a tmux process nor fabricates
 * OpenRig session identity from a T3 browser tab.
 */
export class T3ChatGptClient implements T3SessionClient {
  constructor(private readonly root = process.env.OPENRIG_T3_CODE_ROOT
    ?? path.resolve(process.cwd(), "..", "t3code")) {}

  request(input: Record<string, unknown>): Promise<unknown> {
    const script = path.join(this.root, "scripts", "chatgpt-sessions.mjs");
    if (!fs.existsSync(script)) {
      return Promise.reject(new Error("T3 desktop bridge not installed: set OPENRIG_T3_CODE_ROOT to your T3 Code checkout"));
    }
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [script], { cwd: this.root, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
      let stdout = "";
      let stderr = "";
      let settled = false;
      const timeout = setTimeout(() => child.kill(), 100_000);
      const finish = (error?: Error, value?: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (error) reject(error);
        else resolve(value);
      };
      child.on("error", (error) => finish(error));
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (part: string) => {
        stdout += part;
        if (stdout.length > 2_000_000) {
          child.kill();
          finish(new Error("T3 returned an oversized response"));
        }
      });
      child.stderr.on("data", (part: string) => { stderr = (stderr + part).slice(-4000); });
      child.on("close", (exitCode, signal) => {
        if (settled) return;
        if (signal) return finish(new Error("T3 control request timed out or was interrupted"));
        if (exitCode !== 0) return finish(new Error(stderr.trim() || "T3 bridge process failed"));
        try {
          finish(undefined, JSON.parse(stdout));
        } catch {
          finish(new Error("T3 returned an invalid JSON response"));
        }
      });
      child.stdin.on("error", (error) => finish(error));
      child.stdin.end(JSON.stringify(input));
    });
  }
}

export class T3AgentBridge {
  private readonly bindingsFile: string;
  private readonly sending = new Set<string>();

  constructor(
    private readonly rigRepo: Pick<RigRepository, "listRigs" | "getRig">,
    private readonly t3: T3SessionClient = new T3ChatGptClient(),
    home = process.env.OPENRIG_HOME ?? path.join(os.homedir(), ".openrig"),
  ) {
    this.bindingsFile = path.join(home, "integrations", "t3-chatgpt-bindings.json");
  }

  private allNodes() {
    return this.rigRepo.listRigs().flatMap(rig =>
      (this.rigRepo.getRig(rig.id)?.nodes ?? []).map(node => ({
        id: node.id, rigId: rig.id, rigName: rig.name,
        name: node.label || node.logicalId,
        role: node.role, logicalId: node.logicalId,
      })),
    );
  }

  private bindings(): Record<string, T3AgentBinding> {
    try {
      const stat = fs.statSync(this.bindingsFile);
      if (stat.size > 1_000_000) throw new Error("T3 bindings file is too large");
      const data: unknown = JSON.parse(fs.readFileSync(this.bindingsFile, "utf8"));
      if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("T3 bindings file is invalid");
      const rows = data as Record<string, unknown>;
      for (const [key, value] of Object.entries(rows)) {
        if (!value || typeof value !== "object" || Array.isArray(value) ||
            (value as T3AgentBinding).nodeId !== key ||
            typeof (value as T3AgentBinding).sessionId !== "string") {
          throw new Error("T3 bindings file contains an invalid record");
        }
      }
      return rows as Record<string, T3AgentBinding>;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw error;
    }
  }

  private save(rows: Record<string, T3AgentBinding>): void {
    fs.mkdirSync(path.dirname(this.bindingsFile), { recursive: true });
    const temp = this.bindingsFile + "." + process.pid + ".tmp";
    try {
      fs.writeFileSync(temp, JSON.stringify(rows, null, 2), { flag: "wx" });
      fs.renameSync(temp, this.bindingsFile);
    } finally {
      if (fs.existsSync(temp)) fs.unlinkSync(temp);
    }
  }

  private requireNode(nodeId: string) {
    const node = this.allNodes().find(node => node.id === nodeId);
    if (!node) throw new T3BridgeError(404, "OpenRig seat not found");
    return node;
  }

  private requireBinding(nodeId: string): T3AgentBinding {
    this.requireNode(nodeId);
    const binding = this.bindings()[nodeId];
    if (!binding) throw new T3BridgeError(404, "OpenRig seat has no T3 session binding");
    return binding;
  }

  async sessions(): Promise<T3BrowserSession[]> {
    const value = await this.t3.request({ action: "list", which: "all" });
    if (!value || typeof value !== "object" || !Array.isArray((value as {sessions?: unknown}).sessions)) {
      throw new Error("T3 session response does not contain a sessions list");
    }
    return (value as {sessions: T3BrowserSession[]}).sessions;
  }

  async agents() {
    const rows = this.bindings();
    const roleOrder: Record<string, number> = {
      "global-manager": 0, "project-manager": 1, expert: 2, worker: 3, qa: 4, "hard-review": 5,
    };
    const nodes = this.allNodes().sort((a, b) =>
      (roleOrder[a.role ?? ""] ?? 6) - (roleOrder[b.role ?? ""] ?? 6) || a.name.localeCompare(b.name));
    let sessions: T3BrowserSession[] = [];
    let t3Error: string | null = null;
    try { sessions = await this.sessions(); }
    catch (error) { t3Error = (error as Error).message; }
    const sessionMap = new Map(sessions.map(session => [session.id, session]));
    return {
      t3Online: t3Error === null,
      t3Error,
      agents: nodes.map(node => {
        const binding = rows[node.id] ?? null;
        const session = binding ? (sessionMap.get(binding.sessionId) ?? null) : null;
        return {
          ...node,
          binding,
          session,
          status: !binding ? "unbound" : t3Error ? "t3_offline" : !session ? "session_missing" : (session.status ?? "unknown"),
        };
      }),
    };
  }

  async bind(nodeId: string, sessionId: string) {
    this.requireNode(nodeId);
    if (!/^[\w-]{8,128}$/.test(sessionId)) throw new T3BridgeError(400, "Invalid T3 session ID");
    const sessions = await this.sessions();
    const session = sessions.find(session => session.id === sessionId);
    if (!session) throw new T3BridgeError(404, "T3 session not found");
    const rows = this.bindings();
    const duplicate = Object.values(rows).find(row => row.sessionId === sessionId && row.nodeId !== nodeId);
    if (duplicate) throw new T3BridgeError(409, "T3 session is already bound to another OpenRig seat");
    const binding = { nodeId, sessionId, boundAt: new Date().toISOString() };
    this.save({ ...rows, [nodeId]: binding });
    return { binding, session };
  }

  unbind(nodeId: string) {
    this.requireNode(nodeId);
    if (this.sending.has(nodeId)) throw new T3BridgeError(409, "Cannot unbind while a message is being delivered");
    const rows = this.bindings();
    if (!rows[nodeId]) return { unbound: false };
    delete rows[nodeId];
    this.save(rows);
    return { unbound: true };
  }

  async messages(nodeId: string, count = 5) {
    const { sessionId } = this.requireBinding(nodeId);
    return this.t3.request({ action: "read", sessionId, from: "end", count: Math.max(1, Math.min(20, count)) });
  }

  async send(nodeId: string, message: string) {
    const { sessionId } = this.requireBinding(nodeId);
    if (typeof message !== "string" || !message.trim() || message.length > 30_000) {
      throw new T3BridgeError(400, "Message must contain 1–30,000 characters");
    }
    if (this.sending.has(nodeId)) throw new T3BridgeError(409, "A delivery to this seat is already in progress");
    this.sending.add(nodeId);
    try {
      // A timed-out UI delivery is UNKNOWN, not a failed delivery. Never retry it.
      const result = await this.t3.request({ action: "send", sessionId, message });
      return { sessionId, result };
    } finally {
      this.sending.delete(nodeId);
    }
  }
}

export class T3BridgeError extends Error {
  constructor(readonly status: 400 | 404 | 409, message: string) { super(message); }
}
