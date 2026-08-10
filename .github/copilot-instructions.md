# Soran’t

A Next.js front end for driving video generation on the user's own ComfyUI
instance. Route handlers proxy to ComfyUI; no weights or inference live here.

See [`AGENTS.md`](../AGENTS.md) for repo conventions.

**To set this up against a ComfyUI install or deploy it, follow
[`docs/agent-setup.md`](../docs/agent-setup.md).** That runbook is the single
source of truth — it covers the required custom nodes and models, making
ComfyUI reachable from Vercel, environment variables, and the deploy. Do not
improvise it; most of it is failures that are not obvious in advance.
