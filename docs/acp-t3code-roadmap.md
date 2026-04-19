# ACP roadmap and t3code integration (planning)

This document is **planning and documentation only** for the smol-agent repository. It records known Agent Client Protocol (ACP) limitations, intended directions to address them, and how to experiment with smol-agent against the sibling **[t3code](https://github.com/pingdotgg/t3code)** tree (`../t3code` when both repos live side by side). No integration code is implied in t3code until product decisions are made there.

---

## Context: t3code

**t3code** is the `@t3tools/monorepo` project: a minimal web (and desktop) GUI for coding agents (Codex, Claude, etc.), built with **Turbo**, **Bun**, and **Effect**. It is a separate codebase from smol-agent.

**ACP in t3code today:** the product already drives **OpenCode** and **Cursor (agent)** over **ACP** — same stdio JSON-RPC pattern this repo implements for `smol-agent --acp`. That sets the bar for **smol-agent integration**: behave as another first-class ACP agent backend the UI can spawn and talk to, alongside those existing integrations.

| Direction | Role |
|-----------|------|
| **OpenCode / Cursor via ACP** | Established in t3code; reference behavior for capabilities, lifecycle, and UX expectations. |
| **smol-agent via ACP** | **Planned** — same wire protocol; smol-agent-side work is closing gaps in [Current ACP limitations](#current-acp-limitations-smol-agent) and documenting auth/session semantics; t3code-side wiring is a separate product decision. |

Using smol-agent as an **ACP backend** while editing t3code is already a reasonable local experiment: point the agent jail at the t3code checkout and connect any ACP-capable client (including harnesses that mirror how t3code talks to OpenCode/Cursor) to `smol-agent --acp`.

---

## Current ACP limitations (smol-agent)

These are accurate as of the planning pass that added this document. Treat as a backlog, not a promise of order.

| Area | Current behavior | Risks / notes |
|------|------------------|----------------|
| **Concurrent sessions** | `MAX_SESSIONS = 1` | Global singletons (jail, network clients, sub-agent config) make multi-session unsafe without refactors. |
| **`session/fork` (unstable)** | Not implemented | Nice for “branch” conversations; needs message/session clone + new id. |
| **`unstable_setSessionModel`** | Implemented (`session/set_model`) — calls `Agent#setModel` when idle; same provider family only | Changing provider/backend still requires a new process or session. |
| **MCP `mcpServers` in `newSession` / `load`** | Ignored | Spec allows MCP alongside the agent; we do not connect MCP from ACP params yet. |
| **Remote HTTP server (`--remote`)** | Session ids are UUIDs; disk sessions use smol hex ids | Two different identity models; confusing if you expect one id everywhere. |
| **Authentication** | Shared secret validated against `authenticate._meta.token` | SDK Zod strips unknown top-level fields; token must ride on `_meta` (see README ACP section). |
| **Images / audio in prompts** | Placeholder text only | Full support depends on provider multimodal APIs and `promptCapabilities`. |

---

## Using smol-agent on `../t3code` (today)

Prerequisites:

- Built or linked `smol-agent` from this repo.
- ACP-capable editor or harness (e.g. Zed, or the SDK examples) configured to launch the binary.

**Suggested command** (jail = t3code root):

```bash
cd ../t3code
/path/to/smol-agent --acp -d "$(pwd)"
# Optionally: -m / -p / --api-key / SMOL_AGENT_* env vars for your provider
```

Behavior to expect:

- **Single active session** per connection; start another only after closing or finishing the previous workflow in the client.
- **Session ids** returned from `session/new` match **on-disk** sessions under `.smol-agent/state/sessions/` for that cwd (after the ACP improvements that call `startSession()`).
- **`session/load`** and **`session/resume` (unstable)** use the same ids as those files.
- For **auth**, if `SMOL_AGENT_AUTH_TOKEN` / `--auth-token` is set on the agent process, clients must complete **`authenticate`** with `methodId: "smol_bearer"` and the token in **`_meta.token`**.

This does **not** add smol-agent to t3code’s UI or installer; it only documents how a power user or future integration could wire them.

---

## What “full t3code integration” could mean (future, mostly outside this repo)

Product-level integration would likely live in **t3code** (agent picker entry next to OpenCode/Cursor, command template, env injection, docs). smol-agent would remain a separate binary or optional dependency, exposed through the **same ACP surface** t3code already uses for other agents.

Possible building blocks:

1. **Parity with existing ACP agents** — Session lifecycle, `initialize` / capabilities, and error shapes should not surprise the UI if they already work for OpenCode/Cursor.
2. **Agent definition** — Command: `smol-agent --acp -d <workspaceRoot>`, env for provider and optional `SMOL_AGENT_AUTH_TOKEN`.
3. **Workspace root** — t3code passes the opened folder as `-d`.
4. **Optional** — Wrapper script in t3code repo, health check, or model picker mapped to `unstable_setSessionModel` once implemented.

Until then, treat **manual stdio + editor** (or any ACP test client) as the supported experiment.

---

## Phased plan (smol-agent codebase)

### Phase A — Docs and operator clarity (this repo)

- Keep this roadmap updated when limitations change.
- README: short ACP subsection with link here + auth reminder.
- Optional: add an `examples/acp-env.example` later (not required for this planning pass).

### Phase B — Protocol gaps without large refactors

- **`unstable_setSessionModel`** — done (idle sessions only; same provider/backend as the process).
- Implement **`unstable_forkSession`** as “duplicate messages + new session file” (or explicitly defer with `methodNotFound` until designed).
- **Remote server**: choose **one** story — either align HTTP session ids with persisted sessions or document **dual-ID** semantics and API responses.

### Phase C — MCP

- Parse `mcpServers` from ACP; either connect MCP clients or return a clear **unsupported** capability so clients do not assume tools exist.

### Phase D — Multi-session / isolation (large)

- Audit globals (`setJailDirectory`, search/fetch clients, sub-agent config).
- Either remove globals in favor of per-session context **or** keep `MAX_SESSIONS = 1` by design and document it as a **hard constraint** for the embedded CLI agent.

---

## Handoff for the next session

1. Decide whether **Phase D** (multi-session) is a product goal or we **codify single-session** as permanent for smol-agent ACP.
2. If t3code wants first-class smol-agent support, open tracking in **t3code**; keep this file as the smol-agent-side contract/limitations reference.
3. After any code change to ACP, update the **Current limitations** table above so operators are not misled.
