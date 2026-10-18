# Omni Command

Derived organizational layout from [OpenRig World's public Workshop rig](https://github.com/mvschwarz/openrig-world/tree/main/rigs/workshop), retrieved at `2a5d93c8d8f8aafd5040bea8b74def4cf0f2f0d4` (Apache-2.0).

One global manager coordinates ALL agent-powered projects; each project manager delegates to experts and scoped workers. QA checks are standard. A human or code reviewer is involved only for hard, ambiguous, or high-risk changes.

## Phase 1 status

The T3 integration supports **adopting existing browser ChatGPT sessions into these OpenRig seats**. It does not yet replace OpenRig's tmux-based bootstrap/lifecycle, and this template's listed `codex` runtimes are placeholders for native OpenRig use rather than a request to spawn Codex. **Do not run `rig up` on Windows expecting T3-created sessions** until the headless T3 runtime adapter is implemented.

To seed this topology without starting runtimes, use `node --import tsx scripts/omni/seed-command-rig.ts --home <isolated OPENRIG_HOME>` from the OpenRig checkout. Existing rigs with the same name are not duplicated.

With OpenRig daemon running and its appropriate bearer token, use:
- `GET /api/integrations/t3/sessions`: existing T3 browser sessions.
- `GET /api/integrations/t3/agents`: global manager + subordinate seat roster and T3 status.
- `POST /api/integrations/t3/agents/:id/bind` with `{"sessionId":"..."}`: adopt a session.
- `GET /api/integrations/t3/agents/:id/messages`: read latest turns.
- `POST /api/integrations/t3/agents/:id/send` with `{"message":"..."}`: send one message via T3.
- `DELETE /api/integrations/t3/agents/:id/bind`: detach a session without deleting it.

T3 desktop must be running for browser-backed sessions. A read-only agent listing remains available even if T3 is offline. Browser sessions have partial/heuristic status, not provider-native turn guarantees. Sending cannot be automatically retried when acknowledgement is ambiguous.

**ChatGPT web is also a control surface** through authenticated OmniMCP/OpenRig MCP operations; it should ask the global manager for tasks, query state and direct work without requiring an open T3 window. T3 remains the session renderer and dispatch executor; OmniHub will eventually expose the same operations to Android.

This template does **not** archive Omni Registry or retire legacy Omni session control. Those are Phase 3 migrations.
