---
name: setup
description: Set up Soran't against the user's own ComfyUI install and deploy it to Vercel. Use when someone has cloned this repo and wants to get it running, connect it to their ComfyUI, work out how to make ComfyUI reachable from the internet, fix a connection that reports Offline or Auth failed, or ship it to production.
user_invocable: true
---

# Setting up Soran’t

Read [`docs/agent-setup.md`](../../../docs/agent-setup.md) from the repository
root and follow it.

That runbook is the single source of truth and is deliberately tool-neutral, so
this repo stays usable from any coding agent rather than just this one. Keeping
this file a pointer is what stops the two drifting apart — if something here
needs correcting, correct the runbook.

Two things it asks of you, worth carrying in before you start:

- **Work the phases in order.** Phase 3 fails confusingly when phase 2 was not
  really finished, and the point is that the user finds out now rather than six
  minutes into a generation.
- **Ask before anything outward-facing** — creating Vercel projects, adding
  environment variables, deploying. Local checks need no permission.
