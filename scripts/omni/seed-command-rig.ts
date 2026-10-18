#!/usr/bin/env node
/** Materialize a dormant OpenRig topology without tmux launch. Usage:
 * node --import tsx scripts/omni/seed-command-rig.ts --home <OPENRIG_HOME>
 * A running daemon must NOT hold this database during initial seed.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDb } from "../../packages/daemon/src/db/connection.js";
import { migrate } from "../../packages/daemon/src/db/migrate.js";
import { ALL_MIGRATIONS } from "../../packages/daemon/src/db/all-migrations.js";
import { RigRepository } from "../../packages/daemon/src/domain/rig-repository.js";
import { PodRepository } from "../../packages/daemon/src/domain/pod-repository.js";
import { RigSpecCodec } from "../../packages/daemon/src/domain/rigspec-codec.js";
import { RigSpecSchema } from "../../packages/daemon/src/domain/rigspec-schema.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const template = path.resolve(here, "../../templates/omni-command/rig.yaml");

export function seedCommandRig(home: string, yamlFile = template) {
  const parsed = RigSpecCodec.parse(fs.readFileSync(yamlFile, "utf8"));
  const check = RigSpecSchema.validate(parsed);
  if (!check.valid) throw new Error("Invalid Omni Command RigSpec: " + check.errors.join("; "));
  const spec = RigSpecSchema.normalize(parsed as Record<string, unknown>);
  fs.mkdirSync(home, { recursive: true });
  const db = createDb(path.join(home, "openrig.sqlite"));
  try {
    migrate(db, ALL_MIGRATIONS);
    const repo = new RigRepository(db);
    const pods = new PodRepository(db);
    const existing = repo.findRigsByName(spec.name);
    if (existing.length > 1) throw new Error("Multiple Omni Command rigs already exist; refusing to guess");
    if (existing.length === 1) {
      const rig = repo.getRig(existing[0]!.id);
      const names = spec.pods.flatMap(p => p.members.map(m => p.id + "-" + m.id)).sort();
      const actual = (rig?.nodes ?? []).map(n => n.logicalId).sort();
      if (JSON.stringify(names) !== JSON.stringify(actual)) {
        throw new Error("An Omni Command rig already exists with a different topology. Refusing to overwrite it.");
      }
      return { created: false, rigId: existing[0]!.id, seats: names.length };
    }
    return db.transaction(() => {
      const rig = repo.createRig(spec.name);
      const mapping = new Map<string, string>();
      let seats = 0;
      for (const pod of spec.pods) {
        const record = pods.createPod(rig.id, pod.id, pod.label ?? pod.id, { summary: pod.summary });
        for (const member of pod.members) {
          const node = repo.addNode(rig.id, pod.id + "-" + member.id, {
            role: member.role ?? member.profile,
            runtime: member.runtime ?? "codex",
            label: member.label ?? member.id,
            profile: member.profile,
            agentRef: member.agentRef,
            podId: record.id,
            // No active tmux session exists. An explicit workspace must be selected
            // before a native provider runtime is launched later.
            cwd: undefined,
          });
          mapping.set(pod.id + "." + member.id, node.id);
          seats++;
        }
      }
      for (const edge of spec.edges ?? []) {
        const from = mapping.get(edge.from);
        const to = mapping.get(edge.to);
        if (!from || !to) throw new Error("Unknown Omni Command RigSpec edge " + edge.from + " -> " + edge.to);
        repo.addEdge(rig.id, from, to, edge.kind);
      }
      for (const pod of spec.pods) {
        for (const edge of pod.edges ?? []) {
          const from = mapping.get(pod.id + "." + edge.from);
          const to = mapping.get(pod.id + "." + edge.to);
          if (!from || !to) throw new Error("Unknown pod-local edge");
          repo.addEdge(rig.id, from, to, edge.kind);
        }
      }
      return { created: true, rigId: rig.id, seats };
    })();
  } finally {
    db.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const home = args[0] === "--home" && args[1] ? path.resolve(args[1]) : undefined;
  if (!home) {
    console.error("Usage: node --import tsx scripts/omni/seed-command-rig.ts --home <isolated OPENRIG_HOME>");
    process.exitCode = 2;
  } else {
    try { console.log(JSON.stringify(seedCommandRig(home), null, 2)); }
    catch (error) { console.error((error as Error).message); process.exitCode = 1; }
  }
}
