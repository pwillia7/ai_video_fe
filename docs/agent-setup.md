# Setting up Soran’t — a runbook for coding agents

Plain markdown, no tool-specific syntax. Any coding agent can read and follow
this; nothing here depends on a particular assistant.

**If you are a human:** the [README](../README.md) covers the same ground in a
form meant for reading rather than executing. This file is the version an agent
works from.

You are walking someone through connecting this app to *their* ComfyUI and
getting it deployed. Assume they have a working ComfyUI and nothing else.

Work through the phases in order. Do not skip ahead — phase 3 fails in
confusing ways if phase 2 was not really finished, and the whole point of this
runbook is that they find out early instead of six minutes into a generation.

Ask before doing anything outward-facing: creating Vercel projects, adding
environment variables, deploying. Run local checks freely.

## Phase 0 — Is the toolchain there

```bash
node --version   # 20+
pnpm --version   # if missing: npm i -g pnpm
```

Then `pnpm install`.

If they do not have pnpm and would rather not install it, npm works — the
lockfile is pnpm's, so expect a fresh resolve and say so rather than letting it
look broken.

## Phase 1 — What ComfyUI needs

The app is the easy half. Almost every failed setup is here.

Tell them plainly what has to be true, then let them go do it:

**Custom nodes** — three packs, all installable from ComfyUI Manager by name:

- **OpenAI API** (`hekmon/comfyui-openai-api`) — provides `OAIAPI_Client` and
  `OAIAPI_ChatCompletion`. **Every workflow needs this.** Each one rewrites the
  user's prompt through an LLM before the video model sees it, so without these
  nodes nothing generates at all.
- **ComfyUI-KJNodes** (`kijai/ComfyUI-KJNodes`) — provides
  `GetImageSizeAndCount`, `RandomImageFromBatch`, `AudioConcatenate`. Only Remix
  and Extend need these; the other workflows run without them.
- **MiniMax-H3 Turbo** (`Larryvrh/ComfyUI-MiniMax-H3-Turbo`) — provides
  `MiniMaxH3TurboLoRA`. Only Reference to Video (Turbo) needs it, and it also
  wants the LoRA file listed below. Everything else runs without either.

The remaining node classes are ComfyUI built-ins — including the four
`MiniMaxH3*` sampling nodes and `ComfyMathExpression`. If those come back
missing, their ComfyUI is too old; updating is the fix, not hunting for packs.

A pack that only one workflow needs is worth saying out loud, because the
failure is confusing: everything else generates fine and that one workflow dies
several minutes in, on a class nobody recognises. `pnpm check:nodes` names both
the class and the pack that owns it, so run it rather than guessing.

**An LLM key on the ComfyUI host, plus a patch.** Do not skip this. It is the
most likely reason a setup that looks correct fails partway through its first
generation, and nothing in `check:nodes` can catch it.

The app never sends a key — it stays on the ComfyUI host rather than crossing
the network from Vercel. Two things have to be true:

1. **`OPENAI_API_KEY` is set in the environment ComfyUI actually launches in.**
   Not a different terminal, not their shell profile if ComfyUI runs as a
   service. Same shell as `python main.py`, or `Environment=` in the systemd
   unit.

2. **`custom_nodes/comfyui-openai-api/client.py` is patched to read it.** The
   graphs ship `api_key: "-"` (the pack's "no key needed" placeholder), and the
   node hands that straight to the OpenAI library, which only falls back to the
   environment when the key is `None`. `"-"` is not `None`, so without this
   patch the fallback never fires and OpenAI returns 401 mid-job.

   Upstream does not import `os`, so that line is part of the patch:

   ```python
   import os   # add alongside the existing imports

       @classmethod
       def execute(cls, base_url: str, max_retries: int, timeout: int, api_key: str | None = None) -> io.NodeOutput:
           return io.NodeOutput(
               OpenAI(
                   api_key=(
                       api_key
                       if api_key and api_key != "-"
                       else os.environ.get("OPENAI_API_KEY")
                   ),
                   base_url=base_url,
                   max_retries=max_retries,
                   timeout=timeout
               )
           )
   ```

   Offer to apply this for them if the file is reachable — check whether it is
   already patched first, since re-applying it is not idempotent. Tell them a
   pack update through ComfyUI Manager overwrites it.

Restart ComfyUI after either change.

**Using a local LLM instead?** Point `base_url` at any OpenAI-compatible server
(Ollama, vLLM, LM Studio) in `src/lib/workflows/*.ts`. Those generally need no
key, so the stock `api_key: "-"` is right and the patch above is unnecessary.

**The model name will bite some people.** Every graph asks for
`model: "gpt-5.6-terra"`. If their account cannot reach it the job dies at the
rewrite step with an error that says nothing about models. If they hit that,
have them change it to a model their key can use — once per file in
`src/lib/workflows/`.

**Six model files**, named literally in the graphs:

| File | Directory | Needed by |
| --- | --- | --- |
| `minimax_h3_fl2va_pruned_int8_convrot.safetensors` | `models/diffusion_models/` | all but the reference workflows |
| `minimax_h3_ref2va_pruned_int8_convrot.safetensors` | `models/diffusion_models/` | the reference workflows |
| `qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors` | `models/text_encoders/` | everything |
| `minimax_h3_video_vae_fp16.safetensors` | `models/vae/` | everything |
| `minimax_h3_audio_vae_fp32.safetensors` | `models/vae/` | everything |
| `minimax_h3_turbo_v4_step600_ema.safetensors` | `models/loras/` | Reference to Video (Turbo) only |

Source: <https://docs.comfy.org/tutorials/video/minimax/minimax-h3>. The turbo
LoRA is not from there — see the third node pack above.

The filenames must match, because they are values inside the graph rather than
choices in the UI. If theirs are named differently, the better fix is editing
the `unet_name` / `clip_name` / `vae_name` in the relevant workflow file — one
line, and it survives re-downloading models.

Have them restart ComfyUI after installing nodes.

## Phase 2 — Reachability, and the decision that trips people up

**Ask what they are doing, because the answer changes everything:**

**Running locally only** (`pnpm dev` on the same machine or LAN):
`http://localhost:8188` is fine. Skip to phase 3. Nothing else is needed.

**Deploying to Vercel:** ComfyUI must be reachable *from Vercel's servers*.
A Vercel function is not on their network, so `localhost` and `192.168.x.x`
cannot work. This surprises people — be explicit about it.

Three ways, best first:

### Tailscale Funnel — recommended

Gives real TLS, needs no open inbound ports, and survives a changing home IP.
Terminates TLS on their own machine, so Tailscale relays without decrypting.

On the ComfyUI host:

1. Install Tailscale, sign in.
2. Admin console → DNS → enable **MagicDNS** and **HTTPS Certificates** (Funnel
   issues no certificate without both).
3. Admin console → Access Controls → grant the funnel attribute:
   ```json
   "nodeAttrs": [
     { "target": ["autogroup:member"], "attr": ["funnel"] }
   ]
   ```
4. Point it at ComfyUI's **local** port:
   ```
   tailscale funnel --bg --https=443 localhost:8188
   ```
5. `tailscale funnel status` gives the public hostname —
   `https://their-box.their-tailnet.ts.net`. That is `COMFY_URL`.

Warn them: Funnel is *public*, not tailnet-private. That is the point, since
Vercel cannot reach a tailnet — but it means `COMFY_API_TOKEN` is the only thing
guarding it. Tailscale *Serve* is the private variant and will not work here.

### Dynamic DNS + port forward

Works, and is what to reach for if Tailscale is unwelcome. Home IPs usually
rotate, so a bare IP goes stale; DDNS keeps a hostname pointed at it.

1. Pick a provider — No-IP, DuckDNS, Afraid.org, or whatever their router has
   built in (many have No-IP or DynDNS under WAN/DDNS settings).
2. Register a hostname and set up the updater — router-side if it offers it,
   otherwise the provider's client on the ComfyUI host.
3. Forward an external port to the ComfyUI machine's port 8188.
4. `COMFY_URL` is `http://their-host.ddns.net:<external-port>`.

Two things to say plainly:

- **A forwarded port is not TLS.** Forwarding 8443 to ComfyUI does not encrypt
  anything — the number means nothing on its own. The app works fine over plain
  HTTP because all ComfyUI traffic is server-side, but the bearer token and
  every prompt cross the internet in cleartext. Treat the token as compromised
  if it has ever gone over plain HTTP.
- This exposes ComfyUI to the whole internet. `COMFY_API_TOKEN` via
  ComfyUI-Login (phase 3) is not optional here.

### Raw public IP

Only if their ISP gives them a static IP. Same port forward, `COMFY_URL` is
`http://<ip>:<port>`. It breaks the day the IP changes, which is why DDNS
exists. Do not recommend this unless they say the IP is static.

## Phase 3 — Authentication

If ComfyUI is reachable from the internet at all, it needs
[ComfyUI-Login](https://github.com/liusida/ComfyUI-Login). Without it, anyone
who finds the URL can queue jobs on their GPU.

Install it, set a password, and take the bcrypt hash it prints to the console —
that hash *is* `COMFY_API_TOKEN`, not the password.

**The trap that catches most people:** the hash starts with `$2b$`, and dotenv
treats `$2b` as a variable reference, so pasting it raw into `.env.local`
silently blanks it. Every `$` must be escaped:

```bash
# console prints:  $2b$12$AbCdEf...
COMFY_API_TOKEN=\$2b\$12\$AbCdEf...
```

**Values set in the Vercel dashboard or via `vercel env add` are literal — do
NOT escape them there.** Getting this backwards is the most common cause of
"works locally, 401s in production" and vice versa.

## Phase 4 — Configure and verify locally

```bash
cp .env.example .env.local
```

Fill in `COMFY_URL` and `COMFY_API_TOKEN`. Also generate an app token:

```bash
openssl rand -hex 32
```

That goes in `APP_ACCESS_TOKEN`. Optional locally; **mandatory before
deploying** — without it, anyone who finds the deployed URL drives their GPU.

Now the check that makes this runbook worth following:

```bash
pnpm check:nodes
```

It asks their ComfyUI whether every node class and model file the workflows name
is actually present, and reports which pack each class came from.

Read the output carefully and interpret it for them:

- **Cannot reach ComfyUI** — `COMFY_URL` is wrong, ComfyUI is not running, or
  the port is not open. Not a node problem.
- **Rejected the API token** — phase 3. Check the `$` escaping first; it is
  usually that. Note the script fails fast here rather than reporting 30 missing
  classes, so do not read this as "nothing is installed".
- **Specific classes NOT FOUND** — map them back to the packs in phase 1 and
  name the pack, not just the class.
- **Model files NOT FOUND** — the file is missing or misnamed. Offer both fixes:
  rename the file, or edit the loader input in the workflow.

Then:

```bash
pnpm check:workflows   # definitions agree with their own graphs; needs no ComfyUI
pnpm dev
```

Open <http://localhost:3000>. The header pill should read **Ready**. If it says
**Offline** or **Auth failed**, `/api/health` returns which in plain JSON.

Have them run one generation before deploying — **Text to Video** is the
cheapest test since it needs no upload. A first run proves the models load and
the OpenAI key on the ComfyUI host works, which no static check can.

## Phase 5 — Deploy to Vercel

Only once a local generation has actually succeeded. Deploying a setup that has
never worked just moves the debugging somewhere with worse feedback.

```bash
pnpm i -g vercel   # if needed
vercel login
vercel link
```

Then the environment. **No `$` escaping here** — these are literal:

```bash
vercel env add COMFY_URL production
vercel env add COMFY_API_TOKEN production
vercel env add APP_ACCESS_TOKEN production
```

`vercel env add` reads the value from the prompt or stdin. Do not pass
`NAME=value` as an argument.

Confirm `COMFY_URL` is the *public* one from phase 2, not `localhost`. This is
the single most common deployment failure and it is worth checking out loud.

Then:

```bash
vercel deploy --prod
```

Afterwards, verify: load the deployment, expect the token gate, enter the
`APP_ACCESS_TOKEN`, confirm the pill reads **Ready**, run one generation.

### If they connect the GitHub repo instead

Push to `main` deploys production; any other branch gets a preview. Two things
to tell them:

- Vercel Authentication does not cover production deployments on Hobby and Pro,
  so production is publicly reachable and `APP_ACCESS_TOKEN` is the only gate.
- If their fork is public, leave **Git Fork Protection** on (Project Settings →
  Security, on by default). It stops a stranger's pull request from building
  with their environment variables in scope — which would hand over the ComfyUI
  token. If they do not use preview deployments, removing `COMFY_URL` and
  `COMFY_API_TOKEN` from the Preview scope entirely is stronger still.

## When something is wrong

| Symptom | Look at |
| --- | --- |
| Pill reads **Offline** | `COMFY_URL`; ComfyUI running; port reachable from where the app runs |
| Pill reads **Auth failed** | `COMFY_API_TOKEN`; the `$` escaping; ComfyUI-Login enabled |
| Works locally, fails deployed | `COMFY_URL` is probably still `localhost`; or `$` was escaped in Vercel when it should not be |
| Valid token still rejected | ComfyUI started with `--enable-cors-header <specific-origin>` makes the bearer check unreachable. Drop the flag or set it to `*` |
| Generation fails on a node class | `pnpm check:nodes` — a pack is missing |
| Generation fails mentioning the LLM | The OpenAI key on the ComfyUI host, not this app |
| A generation just stops | ComfyUI restarting drops its history; the job shows as **Lost** |

`/api/health` is the fastest single source of truth — it reports `reachable`,
`authorized` and `secure` separately, so it distinguishes "cannot connect" from
"connected but refused".
