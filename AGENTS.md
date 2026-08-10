<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Soran’t

A Next.js front end for driving video generation on the user's own ComfyUI
instance. No weights, no inference, no database — every route handler proxies to
ComfyUI, which lives on their machine, not here.

## Setting it up

**If the user wants to get this running against their ComfyUI, or deploy it,
follow [`docs/agent-setup.md`](docs/agent-setup.md).** It is a phase-by-phase
runbook covering the custom nodes and models ComfyUI needs, making ComfyUI
reachable from Vercel, the environment variables, and the deploy.

Do not improvise that process. Most of the runbook is failures that are
non-obvious in advance — a placeholder API key that has to be patched out of a
third-party node, a bcrypt token that is escaped in one place and literal in
another, a `COMFY_URL` that has to resolve from Vercel's network rather than the
user's laptop. Working it out from first principles will cost the user an
afternoon.

## Working on the code

- **Workflows are the interesting part.** `src/lib/workflows/` holds ComfyUI
  graphs verbatim plus a declaration of which node inputs the UI may drive.
  Never hand-edit a graph to change a value the UI should own — add a `param`
  with a `target` instead.
- **`pnpm check:workflows`** validates every param target against its graph and
  needs nothing but this repo. Run it after touching anything under
  `src/lib/workflows/`.
- **`pnpm check:nodes`** asks a real ComfyUI whether the classes and model files
  the graphs name are installed. Needs `COMFY_URL`.
- **`pnpm typecheck`** before calling anything done. There is no lint script —
  `next lint` was removed in Next 16.
- **Secrets never enter the repo.** `COMFY_URL`, `COMFY_API_TOKEN` and
  `APP_ACCESS_TOKEN` come from the environment and are read server-side only.
  Nothing under `src/lib/env.ts` may be imported from a client component.
