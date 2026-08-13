# Soran’t

A small Next.js front end for driving video generation on your own ComfyUI
instance. Deploys to Vercel; the ComfyUI box stays where it is.

![The Extend workflow running: workflow picker and settings on the left, the
finished clip and generation history on the
right](https://i.imgur.com/cUqFq7x.png)

Five MiniMax H3 workflows — text to video, image to video, reference to video,
**Remix** (rebuild a clip you already made) and **Extend** (carry one on past
where it stopped) — each with a hand-picked set of controls rather than the
whole graph. All but Remix can be run in **Turbo**, a switch that applies a
distilled LoRA and samples in a handful of steps instead of a dozen or more;
all five carry **SageAttention** and **Spectrum**, which swap the attention
kernel and forecast sampler steps respectively. All three stack, and **all three
start on** — they are how these graphs are meant to be run here, so the switches
are there to take one back out. That does mean a first run needs every node pack
below. Generations queue, run in the background, and stay in a per-device
history you can replay, download or feed straight back in.

It is a front end and nothing else: no model weights, no inference, no
database. Everything expensive happens on your ComfyUI machine.

---

## Quick start

### Let an agent do it

This repo ships a setup runbook written for coding agents:
[`docs/agent-setup.md`](docs/agent-setup.md). Clone the repo, open it in
whatever agent you use, and ask it to set the project up.

| Agent | How it finds the runbook |
| --- | --- |
| [Claude Code](https://claude.com/claude-code) | `/setup`, or via `CLAUDE.md` |
| Cursor, VS Code / Copilot | a `setup` skill, or via `AGENTS.md` |
| Codex, Jules, Zed, Amp… | `AGENTS.md` |
| Anything else | Point it at `docs/agent-setup.md` |

The `setup` skill is the same twenty-line pointer at two paths,
`.claude/skills/` and `.agents/skills/`, because agents agree on the `SKILL.md`
format but not on where to look for it. Cursor reads both, VS Code reads both,
Claude Code reads only the first.

It walks the whole thing: checks your ComfyUI has the right custom nodes and
model files, applies the node patch the LLM stage needs, works out how to make
ComfyUI reachable from Vercel, handles the `.env.local` escaping trap that
catches nearly everyone, verifies a generation locally, then deploys. It reads
the actual errors — a missing node comes back as the pack you need to install
rather than a class name.

The runbook is plain markdown with nothing tool-specific in it, so it doubles as
a checklist if you would rather do it yourself.

### Or by hand

Four steps, in this order. Doing them out of order is the usual reason a setup
fails confusingly.

1. [Get ComfyUI ready](#1-get-comfyui-ready) — three node packs, six model files
2. [Make ComfyUI reachable](#2-make-comfyui-reachable) — only if deploying
3. [Run it locally](#3-run-it-locally)
4. [Deploy to Vercel](#4-deploy-to-vercel)

---

## 1. Get ComfyUI ready

This is the part that takes effort. The app itself is a few minutes.

You need a **recent ComfyUI** — the workflows use MiniMax H3
(`MiniMaxH3ImageToVideo`, `MiniMaxH3ReferenceToVideo`) and the newer video nodes
(`LoadVideo`, `CreateVideo`, `GetVideoComponents`, `VideoFrameSample`). All are
built in, but only on a build new enough to have them. If the checker below
reports those missing, update ComfyUI rather than hunting for node packs.

### Custom nodes

Most of the node classes these graphs use are ComfyUI built-ins. Eight are not.
The first three packs install from ComfyUI Manager by name:

| Pack | Provides | Needed by |
| --- | --- | --- |
| [comfyui-openai-api](https://github.com/hekmon/comfyui-openai-api) (Manager: "OpenAI API") | `OAIAPI_Client`, `OAIAPI_ChatCompletion` | **every** workflow |
| [ComfyUI-KJNodes](https://github.com/kijai/ComfyUI-KJNodes) | `GetImageSizeAndCount`, `RandomImageFromBatch`, `AudioConcatenate`, `PathchSageAttentionKJ` | Remix, Extend, and the SageAttention switch everywhere |
| [ComfyUI-MiniMax-H3-Turbo](https://github.com/Larryvrh/ComfyUI-MiniMax-H3-Turbo) (Manager: "MiniMax-H3 Turbo") | `MiniMaxH3TurboLoRA`, `MiniMaxH3TurboSampler` | the Turbo switch (every workflow but Remix), and 4 steps on any workflow |
| whichever pack you got `SpectrumApplyMiniMaxH3` from | `SpectrumApplyMiniMaxH3` | the Spectrum switch — every workflow |

The Spectrum row is deliberately not a link: this repo takes the node from a
ComfyUI export rather than shipping a pack, and search by class name in the
Manager is the reliable way to find it. Once it is installed, `pnpm check:nodes`
reads the owning package off your install and prints it, so you never have to
take this table's word for where a class came from.

**The turbo pack is needed at 4 steps even with the Turbo switch off.** The
sampler that pack ships is built for exactly four steps, and the graphs swap it
in whenever the steps control is on 4 — see
[below](#the-4-step-sampler-swaps-itself-in). Four steps without the LoRA is not
a usable take anyway, so in practice this costs nothing, but it is why the row
above says "any workflow".

**The SageAttention switch needs a Python package as well as a node.**
`PathchSageAttentionKJ` patches in a kernel rather than shipping one, so
`sageattention` has to be installed in ComfyUI's own environment. That is the one
requirement on this page `check:nodes` cannot see: it will report the node
present and the run will still fail with the switch on.

**The OpenAI pack is not optional.** Every graph runs what you type through an
LLM before the video model sees it ([details](#the-prompt-is-rewritten-before-the-model-sees-it)),
so without those nodes nothing generates at all.

Restart ComfyUI after installing.

### The LLM key, and a one-line patch you have to apply

The rewrite stage needs an API key, and **this app deliberately never sends
one**. The key lives on the ComfyUI host and never crosses the network from
Vercel. Two steps make that work.

**1. Put the key in ComfyUI's environment.** It has to be set in the shell that
actually launches ComfyUI — setting it in a different terminal does nothing,
which is an easy hour to lose.

```bash
export OPENAI_API_KEY=sk-...     # macOS / Linux, same shell as ComfyUI
python main.py
```

```powershell
$env:OPENAI_API_KEY = "sk-..."   # Windows PowerShell
python main.py
```

Running ComfyUI under systemd or a service manager? Use its own environment
mechanism (`Environment=` in the unit file) rather than a login shell.

**2. Patch the node pack to read it.** This is the part that will otherwise
waste your afternoon. The graphs ship `api_key: "-"`, which is the pack's
"no key needed" placeholder — but its `Client` node passes that string straight
to the OpenAI library, and the library only falls back to `OPENAI_API_KEY` when
the key is `None`. A literal `"-"` is not `None`, so the fallback never fires
and you get a 401 from OpenAI partway through a job.

In `custom_nodes/comfyui-openai-api/client.py`, add the `os` import at the top
(upstream does not have it) and make `execute` fall through:

```python
import os   # <- add this alongside the existing imports

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

Restart ComfyUI. **Updating the pack overwrites this**, so if generations start
failing after a ComfyUI Manager update, check here first.

### Which model the rewrite asks for

All five graphs request `model: "gpt-5.6-terra"`. If your account cannot reach
that model the job fails at the rewrite step, which reads as a generic node
error rather than anything about models. Change it to one your key can actually
use — it appears once per file in `src/lib/workflows/`:

```bash
grep -rn 'model: "' src/lib/workflows/*.ts
```

Not using OpenAI at all? Point `base_url` at any OpenAI-compatible server
(Ollama, vLLM, LM Studio) in the same files. Those usually need no key, in which
case the stock `api_key: "-"` is correct and you can skip the patch above.

### Models

Six files, named literally in the graphs. Get the first five from ComfyUI's
[MiniMax H3 tutorial](https://docs.comfy.org/tutorials/video/minimax/minimax-h3),
which is also the current word on what the model needs from your GPU. The turbo
LoRA comes from its own pack instead.

| File | Goes in | Used by |
| --- | --- | --- |
| `minimax_h3_fl2va_pruned_int8_convrot.safetensors` | `models/diffusion_models/` | text/image to video, Extend |
| `minimax_h3_ref2va_pruned_int8_convrot.safetensors` | `models/diffusion_models/` | reference to video, Remix |
| `qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors` | `models/text_encoders/` | all five |
| `minimax_h3_video_vae_fp16.safetensors` | `models/vae/` | all five |
| `minimax_h3_audio_vae_fp32.safetensors` | `models/vae/` | all five |
| [`minimax_h3_turbo_v4_step600_ema.safetensors`](https://huggingface.co/larryvrh/MiniMax-H3-Turbo-Lora) | `models/loras/` | the Turbo switch — every workflow but Remix |

**The filenames have to match**, because they are values inside the graph rather
than choices in the UI. If your build is named or quantised differently, edit
the `unet_name` / `clip_name` / `vae_name` in the relevant
`src/lib/workflows/*.ts` — one line, and it survives re-downloading models.

---

## 2. Make ComfyUI reachable

**Running locally only?** `http://localhost:8188` works. Skip to
[step 3](#3-run-it-locally).

**Deploying to Vercel?** ComfyUI has to be reachable *from Vercel's servers*. A
Vercel function is not on your network, so `localhost` and `192.168.x.x` cannot
work — this is the single most common deployment failure.

Three ways, best first.

### Tailscale Funnel — recommended

Real TLS, no open inbound ports, and it survives your home IP changing. Funnel
routes by SNI and terminates TLS **on your own machine**, so Tailscale relays the
encrypted stream without decrypting it. Full walkthrough
[below](#putting-comfyui-behind-https-tailscale-funnel).

Short version, on the ComfyUI host:

```shell
tailscale funnel --bg --https=443 localhost:8188
tailscale funnel status     # gives you https://your-box.your-tailnet.ts.net
```

That hostname is your `COMFY_URL`.

> **Funnel is public, not private.** That is the point — Vercel cannot reach a
> tailnet. `COMFY_API_TOKEN` is what guards it. (Tailscale *Serve* is the
> private variant and will not work here.)

### Dynamic DNS + port forward

Most home connections get a new IP periodically, so a bare address goes stale.
DDNS keeps a hostname pointed at whatever your IP currently is.

1. **Pick a provider** — [DuckDNS](https://www.duckdns.org) (free, simple),
   [No-IP](https://www.noip.com), or [Afraid.org](https://freedns.afraid.org).
   Check your router first: many have DDNS built in under WAN settings, which
   saves running a client.
2. **Register a hostname** and set up updating — router-side if it offers it,
   otherwise the provider's updater client on the ComfyUI machine.
3. **Forward a port** on your router to the ComfyUI machine's port `8188`.
4. `COMFY_URL` is `http://your-host.duckdns.org:<external-port>`.

Two things worth being blunt about:

- **A forwarded port is not TLS.** Forwarding 8443 to ComfyUI does not put
  encryption in front of it; the number implies nothing on its own. The app
  works fine over plain HTTP because all ComfyUI traffic is server-side and
  mixed-content rules never apply — but your bearer token and every prompt cross
  the internet in cleartext. Rotate the token if it has ever gone over plain HTTP.
- **This exposes ComfyUI to the internet.** ComfyUI-Login
  ([step 3](#3-run-it-locally)) is not optional once you do this.

### Raw public IP

Only if your ISP gives you a static IP. Same port forward, and `COMFY_URL` is
`http://<your-ip>:<port>`. It breaks the day the IP changes, which is why DDNS
exists — check with your ISP before relying on it.

---

## 3. Run it locally

```bash
pnpm install
cp .env.example .env.local
```

Fill in `.env.local`:

| Variable | |
| --- | --- |
| `COMFY_URL` | Base URL of ComfyUI, no trailing slash. **Required.** Default port is `8188`. |
| `COMFY_API_TOKEN` | The ComfyUI-Login token. See the escaping trap below. |
| `APP_ACCESS_TOKEN` | Shared secret gating this app. Optional locally, **required before deploying**. `openssl rand -hex 32` |
| `GENERATION_TIMEOUT_SECONDS` | How long the UI waits before giving up. Default 1800. |
| `COMFY_BASIC_AUTH` | Optional `user:password` if ComfyUI sits behind basic auth. |
| `COMFY_AUTH_HEADER_NAME` / `_VALUE` | Optional custom auth header. |

### Authentication, and the `$` trap

If ComfyUI is reachable from the internet, install
[ComfyUI-Login](https://github.com/liusida/ComfyUI-Login) — otherwise anyone who
finds the URL can queue jobs on your GPU. Set a password; the bcrypt hash it
prints to the console *is* your `COMFY_API_TOKEN` (not the password).

That hash starts with `$2b$`, and dotenv treats `$2b` as a variable reference —
pasted raw it is silently blanked, and you get an auth failure with a token that
*looks* right in the file. Escape every `$`:

```bash
# console shows: $2b$12$AbCdEf...
COMFY_API_TOKEN=\$2b\$12\$AbCdEf...
```

**Values set in the Vercel dashboard or via `vercel env add` are literal — do
not escape them there.** Getting this backwards either way is the usual cause of
"works locally, 401s in production."

### Check it before you generate

```bash
pnpm check:nodes       # asks YOUR ComfyUI for every class + model the graphs name
pnpm check:workflows   # definitions agree with their graphs; needs no ComfyUI
pnpm dev
```

`check:nodes` is worth running first — the alternative is finding out several
minutes into a job. It names the pack each class came from, so a miss tells you
what to install.

Open <http://localhost:3000>. The header pill should read **Ready**. Then run
one generation — **Text to Video** is the cheapest test, since it needs no
upload. That proves the models load and the OpenAI key on your ComfyUI host
works, which no static check can.

---

## 4. Deploy to Vercel

Do this once a local generation has actually succeeded. Deploying something
that has never worked just moves the debugging somewhere with worse feedback.

```bash
pnpm i -g vercel
vercel login
vercel link
```

Environment — **no `$` escaping here**, these are literal:

```bash
vercel env add COMFY_URL production          # the PUBLIC url from step 2
vercel env add COMFY_API_TOKEN production
vercel env add APP_ACCESS_TOKEN production
vercel deploy --prod
```

Then load it, enter the `APP_ACCESS_TOKEN` at the gate, confirm the pill reads
**Ready**, and generate once.

Connecting the GitHub repo instead gives you push-to-deploy — see [how deploys
happen](#how-deploys-happen) for what that means for branch protection and
public forks.

> **Set `APP_ACCESS_TOKEN`.** Vercel Authentication does not cover production
> deployments on Hobby or Pro, so production is publicly reachable and that
> token is the only thing standing between the internet and your GPU.

---

## Troubleshooting

| Symptom | Look at |
| --- | --- |
| Pill reads **Offline** | `COMFY_URL`; is ComfyUI running; is the port reachable from where the app runs |
| Pill reads **Auth failed** | `COMFY_API_TOKEN`; the `$` escaping; is ComfyUI-Login enabled |
| Works locally, fails deployed | `COMFY_URL` is probably still `localhost` — or `$` got escaped in Vercel, where it should not be |
| Valid token still rejected | ComfyUI started with `--enable-cors-header <specific-origin>` makes the bearer check unreachable. Drop the flag or set it to `*`. [Why](#if-a-correct-token-is-still-rejected) |
| Generation fails naming a node class | `pnpm check:nodes` — a pack is missing |
| Job dies partway with a 401 from OpenAI | `OPENAI_API_KEY` on the ComfyUI host, and [the `client.py` patch](#the-llm-key-and-a-one-line-patch-you-have-to-apply). A pack update reverts it |
| Job dies at the rewrite step, no clear reason | [The model name](#which-model-the-rewrite-asks-for) — your key may not reach `gpt-5.6-terra` |
| A job shows as **Lost** | ComfyUI restarted and dropped its history |
| A job failed saying contact was lost | The connection dropped mid-render, not the workflow. Check the pill, then resubmit — the run may still have finished on the box |

`/api/health` is the fastest single source of truth: it reports `reachable`,
`authorized` and `secure` separately, so it distinguishes "cannot connect" from
"connected but refused."

---

# How it works

Everything below is detail. You do not need it to run the thing.

## How it fits together

```
browser ──HTTPS──> Next.js on Vercel ──HTTP──> ComfyUI (your host, via COMFY_URL)
                   route handlers                 /prompt /history /queue /view
```

Everything goes through server-side route handlers. That is not decoration:

- The page is served over HTTPS and ComfyUI is plain HTTP. A browser refuses to
  call an `http://` origin from an `https://` page, so a direct client→ComfyUI
  call cannot work from a deployed build. The proxy sidesteps it entirely.
- `COMFY_URL` never reaches the client, so the endpoint is not published in your
  JavaScript bundle.
- Video is streamed through `/api/media`, with `Range` forwarded so seeking in
  the player works.

Generation is **submit-then-poll**, not a held-open request. `/api/generate`
returns as soon as ComfyUI accepts the job, then the client polls
`/api/status`. A multi-minute render would outlive any function timeout, and
ComfyUI already owns the queue and history, so there is no server-side job
state to keep.

## The bundled workflows

All five target **MiniMax H3** and produce a video with a generated audio
track. They share sampling, timing and encoding controls via
`minimax-common.ts`.

| Workflow | Output size comes from |
| --- | --- |
| `minimax-h3` — text to video | Aspect ratio + megapixels (`ResolutionSelector`) |
| `minimax-h3-i2v` — image to video | The uploaded image, rescaled by `ImageScaleToTotalPixels` |
| `minimax-h3-ref` — reference to video | Aspect ratio + megapixels (`ResolutionSelector`) |
| `minimax-h3-ref2v` — remix | The source clip's frames, measured by `GetImageSizeAndCount` — length included |
| `minimax-h3-extend` — extend | The source clip's **last frame**, measured by `GetImageSize` |

### Turbo, SageAttention and Spectrum are modes, not more workflows

Four of them — everything but Remix — offer a **Turbo**
switch in the settings panel, **on by default**. It splices a
`MiniMaxH3TurboLoRA` node between the graph's `UNETLoader` and
everything that reads it — in practice `BasicScheduler` and `BasicGuider`, both
of which have to move or the sigmas would be scheduled against the distilled
model while the guider ran the base one. The consumers are found in the graph
rather than listed per workflow, so a re-exported graph cannot silently leave
one behind.

That is the whole difference. The conditioning, the frame maths and the rewrite
stage are untouched, which is why it is a switch rather than five more entries
in the picker. What it changes is the step count: the control's range becomes
4–8 rather than 4–60, because the LoRA is distilled to converge in single
digits and 60 there is not a slower-but-better setting.

**Remix does not offer it**, and not because of the model — it runs the same
`ref2va` UNET as reference to video, which does have the switch. It just samples
at 8 already, the top of the LoRA's range, so turbo there would spend quality
per step and save no time.

Underneath the switch, in turbo only, is **Low VRAM** — the node pack's own
memory-sparing way of applying the LoRA, passed straight through as the
`low_vram` input on the node that gets spliced in. It is off by default and
slower; turn it on if a turbo run dies out of memory on your card. Unlike
everything in the settings form it is remembered once for the whole app rather
than per workflow, because what it answers is a question about the GPU, not
about the shot. It is not a param either, for the plainer reason that the node
it writes to does not exist until the splice happens.

**On reference to video, check a turbo take against a standard one before you
trust it for a likeness.** The LoRA is distilled against `fl2va` and its author
[does not officially support](https://huggingface.co/larryvrh/MiniMax-H3-Turbo-Lora/discussions/10)
`ref2va` yet — "not yet but planned", with reports of identity reference
degrading. It is offered anyway because it demonstrably works here; the first
turbo mode in this app was exactly that graph. The spec still lists the models
the LoRA may land on, so a graph on some third UNET fails `check:workflows`
rather than finishing a run that looks subtly wrong.

#### The patches

Under the Turbo switch are two more. **All five workflows offer both, and both
start on:**

- **SageAttention** splices KJNodes' `PathchSageAttentionKJ`, running attention
  on quantised kernels instead of the default. The class name's misspelling is
  the pack's. It needs `sageattention` installed in ComfyUI's Python as well as
  the node, and it compiles on the first run of a session, so judge what it saves
  on the second take.
- **Spectrum** splices `SpectrumApplyMiniMaxH3`, which forecasts sampler steps
  from the ones already taken instead of computing every one in full.

These are plain on/offs rather than Turbo's two-position control, because off
really is their absence: the node is only in the graph when the switch is on, so
turning all three off gets you back to a graph that needs none of these packs —
which is the thing to try first if a fresh install fails on every workflow. Both
are described in `src/lib/workflows/patches.ts` as a list rather than as named
fields, since they differ only in which node they carry.

**Where the defaults live.** Each switch declares its own starting position —
`defaultOn` on the turbo spec and on each patch — and the settings panel is the
only thing that overrides it, per workflow, remembered in `localStorage`.
Changing a default in code cannot reach a browser that has already run the app,
because the stored maps are written back in full on every load and so always
have an explicit entry: `DEFAULTS_VERSION` in `src/lib/param-storage.ts` moves
the storage keys when that needs to happen, forgetting deliberate choices once
in exchange.

Remix offers both. Turbo is refused there because 8 steps is already the top of
the LoRA's range; these change how a step is arrived at rather than how many
there are, so that argument does not apply.

**They stack, in a fixed order.** Turbo's LoRA attaches to the raw diffusion
model, the attention patch swaps the kernel on whatever weights are in play by
then, and Spectrum wraps whatever model is going to be sampled — so with all
three on the chain is `UNETLoader → MiniMaxH3TurboLoRA → PathchSageAttentionKJ →
SpectrumApplyMiniMaxH3 → BasicScheduler`/`BasicGuider`, which is what the ComfyUI
export they came from does. The order lives in `SPLICE_ORDER` in
`src/lib/workflows/model-chain.ts` rather than in the order the switches happen
to be applied, because any other arrangement would fail nothing and quietly
sample something none of the nodes was meant to produce.

Unlike Turbo, neither patch retunes a control or declares a time estimate. What
they cost is a fact about your machine, and the progress bar learns it from your
own history — which counts each combination of switches separately, so a
Spectrum run is never paced against a standard one's median.

The graphs on disk stay verbatim from their ComfyUI exports — every node is added
to a clone on the way to the queue, in `src/lib/workflows/turbo.ts` and
`patches.ts` over the shared splice in `model-chain.ts`. Every form is checked:
`pnpm check:workflows` proves each splice resolves on its own, that turbo's lands
on the right model, and that they all still work stacked; `pnpm check:nodes` asks
ComfyUI about each patched graph as well as the stored ones, since those nodes
and turbo's LoRA file are the only pieces that need packs nothing else does.

#### The 4-step sampler swaps itself in

The turbo pack also ships `MiniMaxH3TurboSampler`, built for exactly four steps —
its node takes no inputs at all, because the schedule is inside it. **Whenever
the steps control is on 4, that sampler replaces the graph's `KSamplerSelect`.**

This is not a fourth switch, deliberately. Four steps is not a setting that
happens to pair well with this sampler; it is the step count the sampler exists
for. Making it a thing to turn on would only be an opportunity to get the pair
wrong, so the form says what happened rather than asking: a short accented line
appears under the steps slider at 4 and goes away at every other value. Nothing
else in the UI changes, and nothing is remembered between runs — the control is
the whole state.

It fires on the value alone rather than on the value *and* Turbo, even though
four steps is only really useful with the LoRA applied. "Four steps uses the
four-step sampler" is a rule you can hold; "four steps uses it, unless Turbo is
off, in which case it quietly does not" is not.

The swap keeps the node's id rather than adding one and deleting the old, which
is how the ComfyUI export does it. The two graphs are the same graph, and reusing
the id means every link that pointed at the sampler still does — no rewiring to
get wrong, nothing left behind. It lives in `src/lib/workflows/step-sampler.ts`,
and `check:workflows` asserts both halves of the coupling: that the graph has
exactly one `KSamplerSelect` to stand in for, and that 4 is inside the steps
range in *both* modes. The second matters because that failure is silent —
a swap that can never fire would leave every four-step run sampling with the
wrong sampler and coming back a worse video rather than an error.

### The prompt is rewritten before the model sees it

Every graph runs what you type through an LLM first. A
`PrimitiveStringMultiline` node holds the raw input, an `OAIAPI_ChatCompletion`
node expands it into a shot-by-shot description, and only that output reaches
the video node. The image and reference workflows also hand their uploads to
the rewrite, so it can describe what is actually in frame.

**Every director writes MiniMax H3's own structured output format**, which the
model was trained on and reads far more reliably than equivalent free prose:
timed `[Shot N]` markers, a closed camera vocabulary, `(S1)` speaker IDs with
the spoken words inside `<d>[English] ...</d>`, and separate `overall_soundscape`
and `non_diegetic_music` fields. That grammar lives once, in `H3_GRAMMAR`, and
is spliced into all five. The envelope around it is per mode, and there are
three of them — the base three-field form for text-to-video; the same plus an
alignment line naming `<Picture 1>` for the two graphs that start from a frame;
and the six-section full-reference form (`subject_definitions`, `summary`,
`retention_analysis`, `detailed_description`, and the two audio fields) for the
two that run `MiniMaxH3ReferenceToVideo`. The formats are specified in
[MiniMax's own prompt-writing guides](https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/main/docs/VIDEO_PROMPT_WRITING_GUIDE_base_en.md),
and in ComfyUI it is the prompt text that has to carry the reference tags —
nothing in the node pack inserts them.

**Each director is also told how long the finished video will be**, written into
its `system_prompt` by the duration control like any other param value. Not a
nicety: the format requires every shot after the first to open with an absolute
cut time inside the clip's length, and dialogue has to be speakable in the time
there is. The number written in is the *snapped* length — `effectiveSeconds`
mirrors `FRAME_EXPRESSION`, so a 10s request is described as the 10.13s it
actually comes back as. Remix has no duration control, so the browser measures
the loaded clip instead and that goes in; when nothing has been measured yet the
director is told to write no absolute timings at all.

**More than one control shapes that `system_prompt`,** which takes a little
care, because writing a target is an assignment and the second writer would
otherwise silently discard the first. Rather than picking an owner, every
contributor writes the *whole* instruction, assembled by `directorTarget` from
the complete submission: identical inputs give identical strings, so the order
they run in stops mattering and the number of them is free. That works because
`applyParams` resolves every value before it writes any target — a `transform`
receives the full set alongside its own value, not whatever happened to be
resolved first. The length block always lands last, since it is the hardest
constraint in the instruction and the end is where one is most likely to be
obeyed.

**The two reference-format directors name the facets a reference preserves.**
H3's own reference rewriter states them explicitly — identity, proportions,
costume, accessories, markings, subject style — and then repeats those same
words in `retention_analysis` rather than paraphrasing, so the definition and
the commitment have nothing to drift between. `PRESERVATION_FACETS` carries that
vocabulary into `REFERENCE_DIRECTOR` and `REMIX_DIRECTOR`. Two of the axes are
there because they fail quietly: a stylised character drifts toward ordinary
human build and a drawn one toward photographic, and before this neither
proportions nor the subject's own rendering style had a word anywhere in the
instruction. The facets cover appearance only — expression, gaze and body
language belong to the scene, so a subject can be `fully_preserved` and still do
something it is not doing in the photograph.

**On reference to video you set that per image.** Each upload gets a *What to
keep* select, and the four options are the four `retention_analysis` markers in
the terms someone uploading a photograph thinks in:

| What to keep | Marker | What the director is told |
| --- | --- | --- |
| Everything | `fully_preserved` | Only the performance and the setting are the scene's |
| Identity only | `partially_preserved` | Face, build and rendering hold; your prompt dresses them |
| Costume and gear only | `attribute_transfer` | The outfit moves onto whoever the scene casts |
| Style only | `weak_reference` | A manner of rendering, and no subject at all |

The marker used to be inferred from your prose, which is the one part of the
format the director had no evidence for. Your prompt still governs the detail
and still wins outright on a genuine contradiction: the setting says whether the
coat is preserved, the prompt says which coat. A slot with no image contributes
nothing, so an unused second reference cannot put a phantom subject in the
scene.

**A short exclusion clause is allowed, and is not the same as a negative
prompt.** H3 has no negative field, so ruling something out happens in the body,
in one plain sentence beside the style — `No dialogue, no crowd, and no camera
movement.` The directors are told to write one only for what a particular scene
would otherwise plausibly produce uninvited, and the standing ban on boilerplate
negatives is unchanged.

**Which system prompt depends on the workflow**, and the difference is not
cosmetic. The three graphs that invent a scene share their creative direction —
`CREATIVE_DIRECTION`, which fills in everything you left unsaid from a one-line
idea — and mostly differ in envelope: `TEXT_DIRECTOR`, `IMAGE_DIRECTOR` and
`REFERENCE_DIRECTOR`. The last of those carries `PRESERVATION_FACETS` as well,
which it shares with Remix rather than with the two it shares its creative
direction with — the axes only mean anything to a director writing
`retention_analysis`. The two that start from a clip do not use it at all,
because that behaviour is actively wrong once a source exists, and they do not
agree with each other either:

- **Remix** runs `REMIX_DIRECTOR`. What you type is a *delta*, and every detail
  the rewrite invents overwrites something the source already decided. So it
  inverts the default — preserve by instruction, and never write replacement
  dialogue merely because someone is speaking, since the clip's own audio
  already holds the words. How much it changes is proportional to how much you
  asked for: a costume note reaches the costume, while "turn this into
  claymation" is licensed to re-render nearly every surface. Sound moves with
  the world — new weather, room or medium changes what the scene sounds like —
  while the words, voices and music hold unless asked otherwise. Its output is
  the six-section full-reference form, which is what makes the balance hold:
  preservation is one line per label in `retention_analysis` carrying a fixed
  marker (`fully_preserved`, `partially_preserved`, `attribute_transfer`,
  `weak_reference`), so `detailed_description` is left free for the change. The
  narrow/moderate/sweeping tiers now pick those markers rather than trying to
  balance two piles of prose against each other.
- **Extend** runs `EXTEND_DIRECTOR`. Nothing about the source changes there;
  time moves forward, and what you type is what happens *next*. Most of it is
  spent on the seam: no establishing shot, no fade, no cut, no resetting
  characters into neutral poses, and motion already underway carried through
  the join. It also holds the previous clip's dialogue to the previous clip.

All of them live in `minimax-common.ts` and are workflow data: treat them as
data, not prose to tidy. The camera vocabulary in particular is a closed list,
and a synonym that reads better is worse.

**None of them is still verbatim from the ComfyUI exports.** The exports emitted
free prose, which the model reads less reliably than its own format, and the
export shared one director across three modes that want three different ones.
`REMIX_DIRECTOR` had diverged even further: it was originally pinned near
"preserve everything", roughly Sora's mildest remix setting, where its own remix
ran a dial from there up to replacing whole buildings — and held that low, a
sweeping request came back as the source with a wash over it, and the soundtrack
never moved even when the world it was recorded in did. If a ComfyUI workflow is
re-exported over any of these files, all of it is lost, so the better fix is to
make the same edits on the ComfyUI side.

Two consequences:

- **The prompt param targets the input node, not the video node.** On these
  graphs `MiniMaxH3ImageToVideo.prompt` is a link, not a value. Writing to it
  would be overwritten at execution time and the user's text would vanish.
- **`api_key` is `"-"` in every export**, and that is deliberate: the key stays
  on the ComfyUI host and never crosses the network from Vercel. It also means
  the node pack needs [the small patch](#the-llm-key-and-a-one-line-patch-you-have-to-apply)
  that makes `"-"` fall through to `OPENAI_API_KEY`, because upstream sends the
  placeholder to OpenAI as if it were a real key. If the host cannot reach the
  API the rewrite node fails and takes the whole job with it — there is no
  bypass wired into these graphs.

### Image to video

`LoadImage` takes a *filename*, not image data, so the file has to exist in
ComfyUI's input directory before the prompt is queued. `POST /api/upload`
relays a browser upload to ComfyUI's `/upload/image` and returns the reference
that `LoadImage` needs. The upload happens as soon as a file is chosen, so a
rejected image surfaces immediately rather than failing a generation you have
already committed to.

Two constraints govern the upload path:

- **`api()` must not set a Content-Type on FormData.** The browser generates
  `multipart/form-data; boundary=...` itself, and overwriting that header strips
  the boundary, so the server parses an empty form and reports "No image was
  included in the upload." This bit once — the shared client helper was setting
  `application/json` on every request that had a body.
- **Vercel caps function request bodies at 4.5 MB** (`413
  FUNCTION_PAYLOAD_TOO_LARGE`), enforced before the handler runs. The client
  downscales anything over 4 MB in a canvas and re-encodes as JPEG rather than
  letting it fail. Nothing is lost: `ImageScaleToTotalPixels` rescales to about
  1 MP server-side anyway, and alpha is meaningless for a video's first frame.

One thing about that graph is easy to get wrong: **`image_megapixels` is the
real resolution control**, because width and height come from `GetImageSize`
reading the rescaled upload rather than from any size picker. There is no
`ResolutionSelector` in this graph at all — an earlier export carried an
orphaned one, and the current export drops it.

### Remix

`minimax-h3-ref2v` takes a clip and rebuilds it. Everything the graph needs is
derived from that one input:

- `LoadVideo` (154) loads it, and `GetVideoComponents` (153) splits it into
  frames and audio, which become `ref_videos.ref_video_0` and
  `ref_audios.ref_audio_0`.
  That pair is the **only** visual input the sampler gets.
- `VideoFrameSample` (155) takes five frames spread evenly across it and
  `GetVideoComponents` (156) turns them back into images, which go to the
  prompt director and nowhere else — so the rewrite can see the clip it is
  editing instead of working blind from a filename.
- `GetImageSizeAndCount` (163) measures the clip's own frames — not the
  five-frame sample — and supplies all three dimensions of the output: width,
  height, and length as a frame count. A remix comes back the same shape and
  the same length as what went in, so this graph has neither a
  `ResolutionSelector` nor a duration node, and no frame-count expression to
  derive one from.

An earlier version also wired those five frames into `ref_images.ref_image_0..4`
on the reference node, handing the model the same footage twice — once as a
video reference and again as five stills to reconcile with it. That graph is
kept, unregistered, at `archive/minimax-h3-remix-frame-refs.ts`; it still
compiles, so a rename in `minimax-common.ts` surfaces there rather than letting
it rot.

**The clip is the only input the form offers.** There are no image, audio, size
or duration controls, and that is the point rather than an omission: every one
of those is a consequence of the clip, so a picker would imply a choice that
does not exist. What stays editable is what the clip cannot decide: the prompt
and the sampling settings.

A clip can arrive two ways — the Remix button, or an upload. Uploads are held
to **768×1344, 20 seconds and 4 MB** (`video-upload.tsx`). The size and length
limits matter more here than the file-size one: the remix is generated at the
source's own dimensions and for as many frames as it has, so an oversized clip
does not merely upload slowly, it asks the model for a canvas it was never
built for. Both are checked in the browser before the upload starts, because
reading them needs a decoder and the browser already has one — and because
there is no point sending a file that was never going to work.

**Remix** on a finished generation is the quickest way in. It selects this
workflow, loads the clip, carries the prompt it was made with across, and
stops — nothing is submitted, because the point is to edit before running.
Which settings travel is the `carry` list on the workflow's own `clipTarget`;
the seed deliberately does not, since reusing it would pin the new take to the
old one's noise.

The copy is the part that needs a route of its own. ComfyUI writes what a
workflow produces to its **output** directory and only lets loader nodes read
from its **input** directory, and nothing in its HTTP API moves a file between
the two. So `POST /api/remix` fetches the clip through `/view` and posts it
back to `/upload/image` — which is the upload endpoint for any media, there is
no `/upload/video`. That runs server-side rather than round-tripping through
the browser: a generated clip is comfortably past the 4.5 MB body cap, and the
bytes would otherwise cross the user's connection twice for no reason. Extend
uses the same route: the two differ in what they do with a clip, not in how it
reaches ComfyUI's input directory.

### Extend

`minimax-h3-extend` keeps a clip running past where it stopped. Structurally it
is the image-to-video graph with the clip's own last frame standing in for an
upload, plus a join on the way out:

- `LoadVideo` (126) and `GetVideoComponents` (127) split the clip, and
  `RandomImageFromBatch` (128) takes the **last frame** of that sequence
  (`start_index: -1`, `num_frames: 1`). That one frame is the whole bridge —
  `MiniMaxH3ImageToVideo` gets it as `first_frame`, `GetImageSize` (120)
  measures it for the output size, and the prompt director is shown it. Nothing
  else about the source reaches the model.
- The `105:*` nodes are the same sampler stack and the same duration →
  frame-count expression as the other generating graphs.
- `BatchImagesNode` (131) concatenates the source frames with the generated
  ones, `AudioConcatenate` (135) does the same to the two audio tracks, and
  137/138 save the result. **The output is the whole video**, not the segment
  on its own — which is what lets an extension be extended again with no
  reassembly by hand.

Two consequences worth knowing before changing anything:

- **Duration times the addition, not the result.** Ask for 5 seconds on a
  10-second clip and 15 seconds come back. The control is relabelled *Added
  time* for exactly this reason. Sampling cost stays flat as the clip grows,
  since only the new segment is ever generated; the decode and re-encode of the
  join do not.
- **The prompt does not carry over from the source**, which is the one place
  Extend deliberately differs from Remix. The text that made the source
  describes the source, and `EXTEND_DIRECTOR` reads its input as what happens
  next — handing it the old prompt would ask the clip to do again what it just
  did. That is why `carry` lives on each workflow's `clipTarget` rather than
  being one list in the UI.

Both buttons are registry-driven: a workflow declares
`clipTarget: { action, videoParam, carry? }`, and `studio.tsx` finds the
destination for each action rather than naming a workflow id. Registering a
different graph behind Extend moves the button with it, and a build with no
workflow declaring an action simply does not render that button. In the
history, whatever a hand-off produces is threaded under the generation it came
from (`derivedFrom` on the job, `lineageOrder` in `jobs.ts`) — the same
indentation serves remixes and extensions.

### Audio

Every graph decodes an audio track into `CreateVideo`, so they set
`hasAudio: true`. The result player does not autoplay audio workflows —
browsers only allow autoplay while muted, which would throw away the
soundtrack the model just spent minutes generating.

## Adding your own workflow

The registry lives in `src/lib/workflows/`. A workflow is the ComfyUI graph
**verbatim** plus a declaration of which node inputs the UI may drive — the
graph is never rewritten by hand.

`archive/` holds superseded graphs that are worth keeping to compare against.
They are complete workflow definitions and still typecheck, but nothing imports
them, so they are neither validated by `check:workflows` nor bundled. Adding one
back is a single line in `index.ts`.

1. In ComfyUI: **Workflow → Export (API)**. You get a flat map of
   `node id -> { class_type, inputs }`, where `["1", 0]` means output 0 of node 1.
2. Drop it into a new file next to `minimax-h3.ts` as the `graph`.
3. Declare `params`, pointing each control at the node inputs it writes:

```ts
{
  id: "prompt",
  label: "Prompt",
  type: "textarea",
  default: "",
  group: "Prompt",
  targets: [{ node: "3", input: "text" }],
}
```

One control can drive several inputs, and a `transform` on a target derives what
each one receives — so a single value can go to one node as a number and to
another baked into a formula string. A `transform` is handed the whole
submission alongside its own value, so an input can depend on several controls;
where it does, have each of them write the complete value rather than a piece of
it, because a target write is an assignment and the last one wins. The prompt
directors' `system_prompt` is the worked example.

4. Register it in `src/lib/workflows/index.ts`.
5. Run the validator:

```bash
pnpm check:workflows
```

It resolves every `target` against the graph and fails on anything stale, so a
bad mapping surfaces immediately instead of sending a subtly wrong job to the
GPU. The same check runs on `/api/workflows` and again before every submit. It
also catches four couplings that are invisible in a diff: that turbo's LoRA
lands on a model it belongs on; that each patch still finds something to sit in
front of once the switches above it have moved the wiring; that the 4-step
sampler has exactly one `KSamplerSelect` to stand in for and that 4 is still
inside the steps range in both modes; and that a graph driving a prompt director
declares a `duration` or `source_seconds` param — the length block is found by
param id, so renaming one would otherwise drop it from the instruction and the
only symptom would be shot cut times landing past the end of the video.

Param types available: `text`, `textarea`, `number`, `slider`, `select`,
`toggle`, `seed`, `image`, `video`. Mark a param `advanced: true` to tuck it behind the disclosure;
`group` sets the section heading.

## Queueing, history and leaving it running

**The form never locks.** Submitting appends to a list rather than taking a
global lock, so you can queue several runs and ComfyUI works through them in
order. Each carries its own progress, queue position and cancel button.

**Cancel targets a specific prompt.** `POST /interrupt` with no body is a
*global* interrupt in ComfyUI — it kills whatever happens to be executing,
which with a queue may not be the job you cancelled. Newer ComfyUI has
`POST /api/jobs/{id}/cancel`, which handles either state in one idempotent
call; older builds fall back to de-queueing *and* interrupting with an explicit
`prompt_id`, both of which are no-ops when they do not apply. Either way
nothing else in the queue is touched.

**Progress is an estimate, and the API cannot do better.** A running job in
ComfyUI's HTTP API reports only its id, status, priority and creation time —
no step counts and no ETA. Step-level progress exists solely on the WebSocket,
which Vercel functions cannot proxy. So the remaining-time readout is the
median render time of that workflow's last few runs on this device, measured
from when rendering *started* rather than when the job was queued.

**History is kept per device** in `localStorage` — the last 50 runs, with their
prompt, settings and result. Only the *reference* is stored, never the video:
the file stays on the ComfyUI box and streams through `/api/media` on demand.
Storing media here would exhaust the few megabytes localStorage allows after a
couple of clips. The trade is that an entry stops playing if ComfyUI's output
directory is cleared.

The list is **grouped by the day a generation was started**, newest day open and
the rest collapsed, so a long history reads as an index rather than a wall. Days
are worked out from local calendar date parts rather than by dividing the
timestamp, because a day is not reliably 24 hours long once daylight saving is
involved. Each day header can download or delete its generations in one go,
both behind an inline confirmation — deleting only forgets where the files are,
which is why the prompt says so.

The settings kept are the **resolved** ones — what the server made of the form,
not what the form held. That distinction is the point: a run submitted with the
seed on "random" records the number it actually got, which is what makes the
take reproducible. **Settings** on the stage opens them for whichever generation
is being viewed, failed ones included, where the first question is usually what
it was run with.

That record outlives the workflow that made it. Params get renamed, removed or
added between a run and the reading of it, so the modal labels what the current
definition still recognises and falls back to the raw id for the rest, rather
than dropping values someone is trying to reconstruct from.

Active jobs are polled in **one batched request** regardless of how many are in
flight — `/api/status?promptIds=a,b,c` reads the queue once and resolves every
id against it, so a deep queue does not multiply load on the GPU box.

**A job is given up on if the connection goes, rather than polled forever.**
Failed status checks are retried with a backoff, and once there have been at
least three in a row spanning at least 45 seconds — roughly a minute in practice,
either way — every job in flight is marked failed and sent a cancel. Both
conditions are needed: a refused connection answers instantly, so a count alone
would kill a good render over a few seconds of nothing, while an unreachable host
is usually blackholed rather than refused, and a single check then burns the
route's whole 20-second ComfyUI timeout, which is not evidence of anything yet.

The cancel is best effort and goes out after the job is already marked, because
if ComfyUI is unreachable the cancel fails exactly as the status checks did and
waiting on two more timeouts to be told what you already know is worse than
being told the run may outlive the tab. When it does land — the box is up but
something in between is not — it saves the GPU several minutes on a clip nothing
will collect. Either way the failure names what happened, rather than leaving a
progress bar filling against an estimate for a run that stopped being watched.

**Desktop notifications.** The bell in the header opts in (the permission prompt
has to be tied to a click, which is why it is a button). Each finished or failed
run notifies once, and only while the tab is hidden — if you are watching the
progress bar already, it would just be noise.

The ceiling: the Notifications API needs the page alive, so this covers a
backgrounded tab, not a closed one. Reaching a closed tab needs a service worker
and a push service, which is a separate piece of infrastructure.

Browsers also throttle timers in hidden tabs — to roughly once a minute after a
few minutes — so a notification can lag the actual finish by up to that long.
The poll fires immediately on `visibilitychange`, so the moment you look at the
tab the state is correct regardless.

## ComfyUI-Login authentication

Set up for [liusida/ComfyUI-Login](https://github.com/liusida/ComfyUI-Login). Every
outbound call carries `Authorization: Bearer <COMFY_API_TOKEN>`. The token value is
the bcrypt hash the node prints to the ComfyUI console when you set a password.

The Bearer header is used rather than the `?token=` query form the README also
offers, because a bcrypt hash contains `/` and `+` that need URL escaping, and
because query strings land in access logs.

### How auth failures surface

An auth failure from ComfyUI is reported as **502, never 401**. A 401 from this
app's own API means the caller's `APP_ACCESS_TOKEN` is wrong, and the UI reacts by
clearing it and showing the token gate — which would be entirely the wrong
response to *our* token being misconfigured.

Three refusal shapes are handled, each with its own message, and all report
`reachable: true, authorized: false` so the header pill reads **Auth failed**
rather than **Offline**:

| ComfyUI responds | Detected as |
| --- | --- |
| `401` / `403` | token rejected or missing |
| `302 → /login` | redirect chasing is disabled, so this cannot masquerade as success |
| `200` with `text/html` | login page served instead of JSON |

The last two matter because without the guards a login wall would either return
HTML through a followed redirect or parse-error as `Unexpected token <`.

Verified against a mock reproducing all four cases, and then against a live
instance with the login node enabled: unauthenticated calls redirect to
`/login`, a wrong token is rejected, and the correct token authenticates.

Note that some builds of the login node return **302 for every `Accept` header**,
including `application/json`, where newer source returns 401 JSON to non-HTML
clients. Following that redirect yields `200 text/html`, which is precisely the
`Unexpected token <` the redirect guard exists to prevent.

### If a correct token is still rejected

Bearer auth sits behind a CORS condition in the plugin:

```python
if args.enable_cors_header is None or args.enable_cors_header == '*' or args.enable_cors_header == request.headers.get('Origin'):
```

Server-side `fetch` sends no `Origin` header, so starting ComfyUI with
`--enable-cors-header <specific-origin>` makes the Bearer check unreachable and
a valid token fails. Drop the flag or set it to `*`.

## Putting ComfyUI behind HTTPS (Tailscale Funnel)

A ComfyUI reached over plain HTTP works fine here — all ComfyUI traffic is
server-side, so mixed-content rules never apply. Beware of assuming otherwise
from a port number: forwarding 8443 to ComfyUI's aiohttp listener does not put
TLS in front of it, and the number implies nothing on its own. What plain HTTP
costs you is
confidentiality of the Bearer token and your prompts in transit.

[Tailscale Funnel](https://tailscale.com/docs/features/tailscale-funnel) fixes
that and lets you close the forwarded port entirely. Funnel routes by SNI and
terminates TLS **on your own machine**, so Tailscale relays the encrypted stream
without decrypting it.

> **Funnel is public, not private.** It puts the service on the open internet by
> name — that is the point, since Vercel's functions are not on your tailnet.
> `COMFY_API_TOKEN` is still doing the access control. (Tailscale *Serve* is the
> tailnet-private variant, which Vercel could not reach.)

Run these on the machine that hosts ComfyUI (the steps below name the Windows
installer; the Tailscale commands are the same on macOS and Linux):

1. Find the port ComfyUI actually listens on **locally** — its own default is
   `8188`. If you reach it on some other port from outside, that is a forward
   in front of it, and Funnel needs the local one.

2. Install Tailscale and sign in.

3. In the admin console → **DNS**, enable **MagicDNS** and **HTTPS
   Certificates**. Funnel will not issue a certificate without both.

4. In the admin console → **Access Controls**, grant the funnel attribute:

   ```json
   "nodeAttrs": [
     {
       "target": ["autogroup:member"],
       "attr":   ["funnel"],
     },
   ],
   ```

5. Start the funnel, pointing at ComfyUI's **local** port:

   ```shell
   tailscale funnel --bg --https=443 localhost:8188
   ```

   `--bg` persists it across reboots. Funnel only permits public ports `443`,
   `8443` and `10000`.

6. Get the public hostname:

   ```shell
   tailscale funnel status
   ```

   It looks like `https://your-box.your-tailnet.ts.net`.

7. Point the app at it — no code changes, just the env var:

   ```bash
   vercel env rm COMFY_URL production
   vercel env add COMFY_URL production   # https://your-box.your-tailnet.ts.net
   ```

   Update `.env.local` too for local development.

8. Confirm it took: the header pill should read **Ready** with no unlocked
   padlock. `/api/health` returns `"secure": true`.

9. Now close any port-forward you had pointing at ComfyUI. Funnel is
   outbound-only, so nothing needs to be exposed inbound any more — this is the
   bigger win, and the reason to prefer it over DDNS.

To undo: `tailscale funnel --https=443 localhost:8188 off`.

## How deploys happen

Connect the GitHub repo to a Vercel project and you get the usual arrangement:

- **Push to `main` → production**
- **Push to any other branch → a preview deployment**, protected by Vercel
  Authentication (a Vercel login is required to view it)

Worth knowing before you wire that up: Vercel Authentication does not cover
production deployments on the Hobby and Pro plans, so production is publicly
reachable and gated only by whatever `APP_ACCESS_TOKEN` you set. A push to
`main` is therefore a public release — work on a branch and merge when you mean
it, and do not deploy without that token set.

`vercel deploy` and `vercel deploy --prod` still work for deploying the working
tree directly, without a commit.

## Security

The ComfyUI-Login node closes the biggest hole — unauthenticated job submission
on a public endpoint. Two things it does not fix:

- **Traffic is plain HTTP until you move to Funnel** (see above). The Bearer
  token and your prompts cross the internet in cleartext, so the token is
  sniffable in transit and replayable.
- **The token is a bcrypt hash used as a static bearer credential**, so it does
  not rotate and does not expire. Treat it as a long-lived secret — and rotate
  it if it has ever been sent over plain HTTP.

`APP_ACCESS_TOKEN` protects *this app*; `COMFY_API_TOKEN` protects ComfyUI. They
are independent, and ComfyUI stays directly reachable regardless of the former.

## Scripts

| Command | |
| --- | --- |
| `pnpm dev` | Dev server |
| `pnpm build` | Production build |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm check:workflows` | Validate param→graph mappings. Needs nothing but this repo. |
| `pnpm check:nodes` | Ask your ComfyUI whether it has the classes and models the graphs name. Needs `COMFY_URL`. |

## Known limits

- **Progress is an estimate.** ComfyUI exposes step-level progress over its
  WebSocket only, and Vercel functions cannot proxy a WebSocket upgrade. The bar
  eases toward 95% against the workflow's `estimatedSeconds` and never claims to
  be done. Real progress would need an SSE relay that opens a WS server-side —
  workable, but it inherits the function timeout ceiling, which is why polling
  is the default.
- **History is per device.** It lives in `localStorage`, so it does not follow
  you between desktop and phone. Making it portable would mean real storage
  (Vercel Blob) and a decision about retention.

## License

MIT — see [LICENSE](LICENSE).

The workflow graphs under `src/lib/workflows/` are ComfyUI exports and are
covered by the same licence, but the things they *name* are not: the MiniMax H3
weights, the Qwen3-VL text encoder and the custom node packs each carry their
own terms. Check those before redistributing anything built on them.

## Support

If this saved you an afternoon, you can
[buy me a coffee](https://buymeacoffee.com/reticulated). ☕
