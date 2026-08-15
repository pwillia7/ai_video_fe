# Soran’t

A small Next.js front end for driving video and music generation on your own
ComfyUI instance. Deploys to Vercel; the ComfyUI box stays where it is.

![The Extend workflow running: workflow picker and settings on the left, the
finished clip and generation history on the
right](https://i.imgur.com/cUqFq7x.png)

Five MiniMax H3 video workflows — text to video, image to video, reference to
video, **Remix** (rebuild a clip you already made) and **Extend** (carry one on
past where it stopped) — plus **Music**, which runs MiniMax Music 3 and comes
back with a song rather than a clip. Each has a hand-picked set of controls
rather than the whole graph. Of the video ones, all but Remix can be run in
**Turbo**, a switch that applies a distilled LoRA and samples in a handful of
steps instead of a dozen or more; all five carry **SageAttention** and
**Spectrum**, which swap the attention kernel and forecast sampler steps
respectively. All three stack, and **all three
start on** — they are how these graphs are meant to be run here, so the switches
are there to take one back out. That does mean a first video run needs every
node pack below; Music needs none of them. Generations queue, run in the
background, and stay in a per-device history you can replay, download or feed
straight back in — a finished clip with **Remix** or **Extend**, a finished
song with **Create video**, which loads it into reference to video as a
reference track alongside whatever pictures you attach.

Every workflow rewrites your prompt through an LLM into the format the model
was trained on, and every workflow has a switch to skip that and send what you
typed, character for character — which also queues a graph with no OpenAI node
in it, if you have no key to give one.

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

1. [Get ComfyUI ready](#1-get-comfyui-ready) — three node packs, nine model files
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

**Music needs no pack but that one.** Every other class in that graph —
`MiniMaxMusic3TextEncode`, `EmptyMiniMaxMusic3LatentAudio`, `SaveAudioAdvanced`,
`VAEDecodeAudioTiled`, `SeedNode`, `ComfySwitchNode` — is a ComfyUI built-in, so
a recent ComfyUI plus the three Music 3 model files below is the whole
requirement. None of the switches apply to it either.

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

Every graph requests `model: "gpt-5.6-terra"` — twice in the music one, which
runs a second call for lyrics. If your account cannot reach
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

Eleven files, named literally in the graphs. Get the seven H3 ones from ComfyUI's
[MiniMax H3 tutorial](https://docs.comfy.org/tutorials/video/minimax/minimax-h3),
which is also the current word on what the model needs from your GPU. The turbo
LoRA comes from its own pack, and the three Music 3 files from
[Comfy-Org/MiniMax-Music-3](https://huggingface.co/Comfy-Org/MiniMax-Music-3).

| File | Goes in | Used by |
| --- | --- | --- |
| `minimax_h3_fl2va_pruned_int8_convrot.safetensors` | `models/diffusion_models/` | text/image to video, Extend |
| `minimax_h3_ref2va_pruned_int8_convrot.safetensors` | `models/diffusion_models/` | reference to video, Remix |
| `minimax_h3_ref2va_bf16.safetensors` | `models/diffusion_models/` | reference to video at 4 steps |
| `qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors` | `models/text_encoders/` | the five video graphs |
| `qwen3vl_32b_minimax_h3_bf16.safetensors` | `models/text_encoders/` | reference to video at 4 steps |
| `minimax_h3_video_vae_fp16.safetensors` | `models/vae/` | the five video graphs |
| `minimax_h3_audio_vae_fp32.safetensors` | `models/vae/` | the five video graphs |
| [`minimax_h3_turbo_v4_step600_ema.safetensors`](https://huggingface.co/larryvrh/MiniMax-H3-Turbo-Lora) | `models/loras/` | the Turbo switch — every video workflow but Remix |
| `minimax_music3_dit_fp16.safetensors` | `models/diffusion_models/` | Music |
| `minimax_music3_text_encoder_pruned_int8_convrot.safetensors` | `models/text_encoders/` | Music |
| `minimax_music3_dav.safetensors` | `models/vae/` | Music |

There is an `int8_convrot` build of the Music 3 DiT for low-VRAM cards. If you
use it, change `unet_name` in `minimax-music3.ts` to match — the filename is a
value in the graph, not a choice in the UI.

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

Five target **MiniMax H3** and produce a video with a generated audio track.
They share sampling, timing and encoding controls via `minimax-common.ts`.

| Workflow | Output size comes from |
| --- | --- |
| `minimax-h3` — text to video | Aspect ratio + megapixels (`ResolutionSelector`) |
| `minimax-h3-i2v` — image to video | The uploaded image, rescaled by `ImageScaleToTotalPixels` |
| `minimax-h3-ref` — reference to video | Aspect ratio + megapixels (`ResolutionSelector`) |
| `minimax-h3-ref2v` — remix | The source clip's frames, measured by `GetImageSizeAndCount` — length included |
| `minimax-h3-extend` — extend | The source clip's **last frame**, measured by `GetImageSize` |

The sixth, `minimax-music3`, is a different model family and the only one that
produces no picture at all — see [Music](#music). It shares the director
machinery and nothing else, and none of the switches below apply to it.

### Turbo, SageAttention and Spectrum are modes, not more workflows

Four of the video workflows — everything but Remix — offer a **Turbo**
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

**Low VRAM** is the node pack's own memory-sparing way of applying the LoRA,
passed straight through as the `low_vram` input on the node that gets spliced
in. It is off by default and slower; turn it on if a turbo run dies out of
memory on your card. Unlike everything in the settings form it is remembered
once for the whole app rather than per workflow, because what it answers is a
question about the GPU, not about the shot. It is not a param either, for the
plainer reason that the node it writes to does not exist until the splice
happens. It lives under **Model** with the patches below, and only appears in
turbo — off, there is no LoRA node for it to say anything about.

**On reference to video, check a turbo take against a standard one before you
trust it for a likeness.** The LoRA is distilled against `fl2va` and its author
[does not officially support](https://huggingface.co/larryvrh/MiniMax-H3-Turbo-Lora/discussions/10)
`ref2va` yet — "not yet but planned", with reports of identity reference
degrading. It is offered anyway because it demonstrably works here; the first
turbo mode in this app was exactly that graph. The spec still lists the models
the LoRA may land on, so a graph on some third UNET fails `check:workflows`
rather than finishing a run that looks subtly wrong.

#### The patches

Under the Turbo switch are two more. **All five video workflows offer both, and
both start on:**

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

They live behind a collapsed **Model** heading with Low VRAM, closed by default,
because none of them is a per-shot decision — they answer questions about the
machine and the install, and once answered they are in the way. The heading
carries a summary of what is on, so shutting the section does not hide the fact
that all of them ship enabled. Turbo stays outside it: it moves the step range
the form below shows, and a control cannot sensibly hide from what it
reconfigures.

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

**Reference to Video refuses Spectrum at 4 steps.** That graph's four-step form
is the ComfyUI export that actually works there — distilled sampler, bf16
weights, no forecaster — so the switch is left out of the run rather than
spliced into a chain it was never part of. It is refused, not turned off: the
setting is kept, the switch shows as off with the reason under it, and it comes
back the moment the step count moves. A reference track pins the steps to 4, so
a track means no Spectrum without a second rule saying so. The declaration is
`suppresses` on that workflow's `stepSampler`, beside the sampler swap and the
model swap it belongs with, and `check:workflows` rejects a name the workflow
does not offer.

**There is no sigma-shift node here, and that is the same as running the
model's own.** ComfyUI's `MiniMaxH3SigmaShift` — shown in the node menu as
*ModelSamplingMiniMaxH3* — sets the video and audio flow shifts the sampler
schedules against. None of these graphs has one, and neither does ComfyUI's own
`video_minimax_h3_r2v` template they came from. Its defaults, `shift_video:
12.0` and `shift_audio: 3.0`, are exactly the `sampling_settings` H3's entry in
`comfy/supported_models.py` already carries, so at those values the node sets
what the sampler was going to use anyway. Every run here is at 12/3, at four
steps and at every other count, and there is nothing to switch off. Adding one
would only be worth it to run *different* shifts, and it would be a node in the
stored graph rather than a switch — so its four-step rule would be an unwiring,
the way `directorBypass` unwires the rewrite, and not the `suppresses` above,
which speaks for nodes that are only there when a switch puts them there.

That is also why `applyParams` coerces before it splices, and why the response
reports the patches a run actually got: the history names the modes a generation
used and the estimate is learned per combination of them, so recording a switch
the graph did not have would put the run in the wrong bucket and name a node
that was never there.

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
is remembered between runs — the control is the whole state.

**On Reference to Video, four steps is a whole form of the graph rather than one
node.** The same trigger also loads the bf16 diffusion model and text encoder in
place of the quantised pair, and refuses the Spectrum switch — which is the
ComfyUI export that actually works there, node for node. All three hang off the
one `stepSampler` declaration, so there is one trigger and one note rather than
three rules that could disagree about which four-step graph this is; `models`
and `suppresses` are covered under [the reference workflow](#create-video-from-a-finished-track)
and [the patches](#the-patches). It is also why a reference track pins the steps
control to 4: that is the only form of the graph a track survives, and pinning
the number is what makes the rest of it follow.

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

Every graph runs what you type through an LLM first, unless you turn that off —
see [sending a prompt unrewritten](#sending-a-prompt-unrewritten), which is the
whole of the escape hatch and is off by default. A
`PrimitiveStringMultiline` node holds the raw input, an `OAIAPI_ChatCompletion`
node expands it into the model's own format, and only that output reaches the
generation node. The image and reference workflows also hand their uploads to
the rewrite, so it can describe what is actually in frame. Everything in this
section is about the five video graphs; the music one runs the same machinery
against a different format, and is described under [Music](#music).

**Every director writes MiniMax H3's own structured output format**, which the
model was trained on and reads far more reliably than equivalent free prose:
timed `[Shot N]` markers, a closed camera vocabulary, `(S1)` speaker IDs with
the spoken words inside `<d>[English] ...</d>`, and separate `overall_soundscape`
and `non_diegetic_music` fields. That grammar lives once, in `H3_GRAMMAR`, and
is spliced into all five video directors. The envelope around it is per mode, and there are
three of them — the base three-field form for text-to-video; the same plus an
alignment line naming `<Picture 1>` for the two graphs that start from a frame;
and the six-section full-reference form (`subject_definitions`, `summary`,
`retention_analysis`, `detailed_description`, and the two audio fields) for the
two that run `MiniMaxH3ReferenceToVideo`. The formats are specified in
[MiniMax's own prompt-writing guides](https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/main/docs/VIDEO_PROMPT_WRITING_GUIDE_base_en.md),
and in ComfyUI it is the prompt text that has to carry the reference tags —
nothing in the node pack inserts them.

Four rules in there are worth naming, because each exists to stop a specific
thing going wrong rather than to tidy the output:

- **`[unclear]`, on Remix.** That director is told to preserve the source's
  dialogue and has never heard the source — it gets five sampled frames and no
  audio. The guide's rule for reused speech is to reproduce it exactly or write
  `[unclear]` for what you cannot make out, never to guess, so without the
  escape the only available move was to invent a plausible line. A guessed line
  is not a preserved line; it is a new one, spoken in place of what was there.
- **A voice inside reused music is not a speaker.** Verbal content that exists
  only within a reused soundtrack cites `<Audio 1>` and gets no `(Sx)`. Remix
  reuses the whole track, so a lyric or a broadcast under the scene was exactly
  what would otherwise be handed a speaker ID.
- **Punctuation inside `<d>` is standardised** to `,` `.` `?` `!` with the
  decoration stripped. Whatever is in there gets spoken, and an emoji is not
  speakable. The words stay verbatim.
- **The style is named in H3's own vocabulary** — Cinematic, live-action,
  2D-animated, 3D CG, claymation, watercolor, vintage film — since every
  director was asked to state a style without ever being given the words the
  model reads most reliably.

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

**On reference to video you set that per image, across four slots.** The graph
wires `ref_images.ref_image_0` through `_3` and the form offers each slot only
once the one before it has an image, so it opens as a single upload and grows
with what you actually use. Every slot gets a *What to keep* select, and the
four options are the four `retention_analysis` markers in the terms someone
uploading a photograph thinks in:

| What to keep | Marker | What the director is told |
| --- | --- | --- |
| Everything | `fully_preserved` | Only the performance and the setting are the scene's |
| Identity only | `partially_preserved` | Face, build and rendering hold; your prompt dresses them |
| Costume and gear only | `attribute_transfer` | The outfit moves onto whoever the scene casts |
| Style only | `weak_reference` | A manner of rendering, and no subject at all |

The marker used to be inferred from your prose, which is the one part of the
format the director had no evidence for. Your prompt still governs the detail
and still wins outright on a genuine contradiction: the setting says whether the
coat is preserved, the prompt says which coat.

**An unused slot leaves the graph entirely.** `finalize` deletes its variadic
input on both consumers — the video node and the batch that shows the references
to the rewrite — and then the `LoadImage` itself, in that order, since dropping
the node while something still links to it would queue a graph referencing a
node that is not there. Leaving a blank loader wired would fail validation, and
leaving a blank slot *described* would put a phantom subject in the scene, so
the director is told about exactly the slots that survived. Both ends count with
`leadingReferences`, which stops at the first gap: filled slots are contiguous
because the form only reveals them that way, but a value cleared afterwards
would otherwise leave the graph sending one picture while the instructions
described two.

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
  API the rewrite node fails and takes the whole job with it, unless the switch
  below has taken the node out of the graph.

### Sending a prompt unrewritten

**Send my prompt as written**, next to the prompt box on every workflow, queues
a graph with no OpenAI node in it at all. The `PrimitiveStringMultiline` the
user typed into is linked straight to whatever was reading the director's
output, and what the model gets is the box, character for character.

Not the same as an empty director. That node would still make the call, still
cost the wait and still return something other than what was typed — the point
is a graph that has nothing to reach the network with, needs no key, and cannot
fail at the rewrite step. It is for someone who has written H3's format by hand,
wants the same words twice, or is working out what the model does with a
particular phrasing. Everything in this section is what it turns off, so a one
line prompt sent this way is a one line prompt.

`director.ts` does the unwiring, and works out what to delete rather than being
told. Everything reading the director's output is repointed at the prompt node,
and then anything no longer reachable from the graph's own output nodes goes:
the `OAIAPI_ChatCompletion`, the `OAIAPI_Client` behind it, and whatever existed
only to be shown to it — Reference to Video's `BatchImagesNode`, Remix's
`VideoFrameSample` and `GetVideoComponents`. Image to Video's upload stays,
because the sampler reads it too. The roots are read *before* the rewiring, or
the batch node nothing reads any more would look like an output node and be
kept. `check:workflows` runs the whole pass on each graph and fails on a link
left pointing at a deleted node, or on a switch that would do nothing.

It runs after `finalize`, which is the only ordering that works: `finalize`
prunes what the run did not use and writes to nodes this then removes.

The controls that only ever wrote the director's instructions leave the form
with it — Reference to Video's four *What to keep* selects, Remix's measured
source length. That is read off the wiring by `hideDirectorOnly` rather than
listed: a param whose every target is the director's node has no other way to
reach the model. Ones that write the graph *and* the director stay, which is
most of them; the duration still sets the length.

Music has the switch too, on its description, and there it is the caption that
goes through verbatim — Music 3's own three-section format, which is worth
reading `music3-director.ts` for before typing one. Only the caption director is
skipped. Node 47 is an OpenAI node as well, but it is there because *Write the
lyrics for me* or *Plan the sections* is on, and those are switches of their
own; with the caption rewrite off it reads what the user typed, which is what
the model is being given as its caption either way.

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

### Create video, from a finished track

The third hand-off, and the only one that is not about a clip.
`minimax-h3-ref` declares it, so pressing **Create video** on a finished song
selects Reference to Video and loads the track into its `Reference track` slot.
The wiring on the graph side is one `LoadAudio` (155) feeding
`ref_audios.ref_audio_0` on the reference node — a variadic input on the same
node the pictures use, so it obeys the same rule: unused means *removed*, along
with its loader, rather than left blank.

Note which workflow that is: `minimax-h3-ref` is **Reference to Video**, the
one with the image slots. `minimax-h3-ref2v` is **Remix**, which takes a clip
and has never had image references — its `MiniMaxH3ReferenceToVideo` gets
`ref_videos.*` and `ref_audios.*` from the source and no `ref_images.*` at all.
Neither of those facts changed here.

The pictures are untouched by it. Reference to Video still offers its **four
reference image slots**, each with its own preservation-facet select, each
revealed by the one before it, all wired to `ref_images.ref_image_0…3` exactly
as before. A run can have four pictures and a track, or a track and nothing
else, or the pictures alone as it always could — which is why the first image
slot is no longer `required`. "At least one of two controls" is not something
`required` can say, so the check moved to `finalize`, where both answers are
visible, and throws the same `ParamError` a rejected value does. A run with no
pictures at all also drops `BatchImagesNode` and the director's `images` input:
an empty batch is not an empty list of images, it is a node that cannot produce
the IMAGE its consumer asked for. `referenceFacets` says so in words as well,
because `REFERENCE_DIRECTOR` otherwise writes the `<Picture 1>` citations its
format calls for at a model that was given none.

**A track pins the run to four steps, and four steps loads different weights.**
The pair used to fail: a track with pictures came back from ComfyUI as
`RuntimeError: The size of tensor a (3) must match the size of tensor b (2) at
non-singleton dimension 0`, and nothing documented why it should — the node's
own docs allow up to 9 images, 3 videos and 3 standalone audios with no
exclusion stated, and reading `nodes_minimax_h3.py`, `ldm/minimax/model.py` and
`text_encoders/minimax.py` turns up no path that treats the combination
differently. It was the quantised weights. At four steps this graph loads
`minimax_h3_ref2va_bf16` and `qwen3vl_32b_minimax_h3_bf16` in place of
`minimax_h3_ref2va_pruned_int8_convrot` and `qwen3vl_32b_minimax_h3_nvfp4_awq`,
and that pair takes references of both kinds together.

Two declarations do it, both in `minimax-h3-ref.ts`. `FOUR_STEP_MODELS` hangs
off the workflow's `stepSampler` — the same trigger that already swaps in the
pack's four-step sampler, so there is one form of this graph at four steps
rather than two rules that could disagree, and `check:nodes` asks ComfyUI about
the bf16 files because `stepSamplerGraph` produces them. `TRACK_PINS_STEPS` is a
`pinnedBy` on the steps control: while a track is loaded the control shows 4,
takes no input, and submits 4 whatever was stored — `applyParams` overwrites the
submitted value after coercion, so a stored 12 from an earlier run cannot sail
past it. Removing the track hands the control back with that number still in it.

Leave **Turbo** on for those runs. Four steps swaps the sampler but not the
distilled LoRA, which is a switch of its own, and four steps without it is not a
usable take — see the note under the control. **Spectrum** goes the other way:
this graph refuses it at four steps, so a run with a track never has the
forecaster in it. That is `suppresses` on the same `stepSampler`, and the switch
shows as off with the reason under it rather than being silently dropped.

Three further things are deliberately *not* true of it:

- **It does not set the length.** The video is as long as the Duration control
  says, capped at 20 seconds. A four-minute song is a reference for those
  seconds — and only those seconds actually go: a `TrimAudioDuration` at node
  167 sits between the loader and the reference node, and **How much of the
  track** decides what it is given. The default is the video's own length, the
  *snapped* one rather than the number on the slider, so the reference matches
  what comes back rather than what was asked for. *A set length* reveals a
  seconds control; *all of it* deletes the trim and wires the loader straight
  through, which is the old behaviour and rarely what anyone wants — MiniMax's
  model card puts a reference track at 2–15 seconds, ComfyUI's standalone
  `ref_audios` path truncates nothing, and a three-minute track is thousands of
  latent frames of packed sequence for a five-second video. Both controls write
  the same node input through the same function, for the same reason the
  director's instructions are assembled by one: a target write is an assignment,
  so each contributor has to produce the whole answer. It is always the start of
  the track; `start_index` stays at 0, and which fifteen seconds you want is the
  first control to add here if it turns out to matter.
- **It is not the output soundtrack.** H3 generates its own audio; the track
  conditions it. `referenceTrack` in `minimax-common.ts` tells the director so,
  because left alone it writes a `non_diegetic_music` section inventing a score
  — which then asks the model for a second piece of music over the one it was
  handed. The director never hears the track: the rewrite stage is shown images
  and nothing else.
- **Nothing is carried across.** The music workflow shares two param ids with
  this one and means something different by both: its `prompt` describes a
  record rather than a scene, and its `duration` counts minutes where this one
  counts seconds. A carried value is written into the destination's form
  *unclamped*, so that second one would arrive out of range and be rejected at
  submit.

Uploading a track by hand works too, and is capped at 4 MB like any other
upload — which a few minutes of mp3 will exceed. The button has no such limit,
because it is the same server-side copy Remix and Extend make.

### How the hand-offs are wired

All three buttons are registry-driven: a workflow declares
`clipTarget: { action, accepts, sourceParam, carry? }`, and `studio.tsx` finds
the destination for each action rather than naming a workflow id. Registering a
different graph behind Extend moves the button with it, and a build with no
workflow declaring an action simply does not render that button.

`accepts` is what keeps a track out of a `LoadVideo` node: the result view
offers the video actions on a file `REUSABLE_VIDEO` matches and the audio ones
on a file `isAudioOnly` matches, so the question is asked of the file that came
back rather than of the workflow that made it. In the history, whatever a
hand-off produces is threaded under the generation it came from (`derivedFrom`
on the job, `lineageOrder` in `jobs.ts`) — the same indentation serves remixes,
extensions and videos built from a track.

### Audio

Every video graph decodes an audio track into `CreateVideo`, so they set
`hasAudio: true`. The result player does not autoplay audio workflows —
browsers only allow autoplay while muted, which would throw away the
soundtrack the model just spent minutes generating.

Music produces no picture at all, which the app tells from the file that came
back rather than from the workflow that made it — `isAudioOnly` in `jobs.ts`
tests the extension, so history entries still answer correctly after a workflow
has been renamed or removed. An audio result gets an `<audio>` player instead of
a 60vh black rectangle, a small note glyph in the history list, and
`contentTypeFor` learned the audio MIME types so an mp3 is played rather than
downloaded.

An audio entry also gets a **play button on its own row**, because the stage is
where the scrubber is and the stage is at the top of the column — hearing
something made an hour ago otherwise meant scrolling up and then finding your
place again. One `<audio>` element serves the whole list rather than one per
row, which is what makes only one track playable at a time and what keeps a
playing track alive when the day it is in is collapsed. It stops itself if the
row is forgotten, since there would be no pause button left to press. The Generate button reads "Generate music" from the workflow's
`makes` field, and a finished mp3 raises a notification that says so.

### Music

`minimax-music3` runs **MiniMax Music 3**. The graph is ComfyUI's own template
for the model, and the only thing added to it is what the two directors write.

| Control | Writes | |
| --- | --- | --- |
| Describe the music | node 44, via the caption director | One line is enough |
| Write the lyrics for me | — | Adds the lyricist at node 47 |
| What the song is about | the lyricist's system prompt | Only while that switch is on |
| Lyrics | `37:13.lyrics` | Verbatim. Empty means instrumental |
| Plan the sections | node 47, filtered through node 48 | Only while the box is empty and the lyricist off |
| Length | `37:13.max_duration`, plus every director | A target; the cut-off is derived from it |
| Seed | `37:38.seed` | Feeds the AR stage and the sampler both |
| Steps | `37:9.steps` | The diffusion stage only |
| Caption guidance | `37:13.cfg_scale` | Holds structure, and the ending |
| Sampler CFG | `37:9.cfg` | Holds the sound. Leave it |
| Top-k | `37:13.top_k` | The one that actually holds a length |

Nothing here sits behind an Advanced disclosure. The two that used to —
guidance and Top-k — turn out to be what decides whether two runs of the same
prompt come back the same length, which is not expert trivia.

**Two inputs reach the model and they are not alike.** `caption` is the music
description and comes from the director at node 46; `lyrics` is what gets
*performed*, and by default it goes from the form to the model untouched. That
asymmetry is the thing to hold on to — anything that lands in the lyrics field
is sung, including a sentence that was meant as commentary.

**The caption is a structured format, not prose.** Music 3 reads three fixed
headings with fixed field labels under each: `Global Metadata` (BPM, key, genre,
emotional progression, imagery, production profile), `Vocal Details` (timbre,
style, harmony, effects) and `Arrangement` (instrument lifecycles, groove,
textures). `MUSIC_DIRECTOR` in `music3-director.ts` writes exactly that. The
field names are copied from the template files in
[MiniMax's music-caption-rewriter skill](https://github.com/MiniMax-AI/MiniMax-Music3#prompt-enhancement)
rather than paraphrased from its prose, because they are what the model was
trained to read. What could not be borrowed is the skill's other half: it works
by progressive disclosure over a thousand bundled reference captions, and this
is one chat completion with no filesystem. So the output contract, the
precedence rules and the refusal to invent unstated facts came across; the
retrieval did not.

The precedence rules are the skill's own five rungs, in its order: user
requirements, then section-local directives from bracketed tags, then caption
implications, then reference characteristics, then conservative defaults. Only
the fourth is reworded here, since there are no reference templates on this side
of it. What the skill has no answer for is length — it accepts a desired length
as a constraint and then defines no mechanism for honouring one, its Arrangement
being "a section-by-section timeline" with no times in it. Everything below
about section sizes is a local extension for exactly that reason.

**Lyrics have three possible sources.**

| Source | When | Wiring |
| --- | --- | --- |
| What you typed | The box has words | Straight to `37:13.lyrics` |
| A second director | *Write the lyrics for me* | Node 47's output, linked in by `finalize` |
| A section plan | The box is empty, *Plan the sections* on | Node 47's output through node 48, linked in by `finalize` |

Node 47 does both of the last two — one node class, one client, two system
prompts, and never both jobs on one run — so `lyricistPrompt` decides which
instruction it gets and `finalize` decides what its output feeds.

The lyricist at node 47 is the same node class as the caption director on the
same client, so it needs nothing new installed, and **its user message is node
46's output**. Reading the finished caption is what lets it know the genre, the
tempo, the singer and the arrangement it is writing into without any of that
being described twice. What the song should be *about* travels the other way, in
the system prompt, because the prompt input is taken and the caption is the
better thing to spend it on.

**An empty box means instrumental, and that took some defending.** The caption
is what decides whether there is a voice, so the instrumental instruction now
overrides your own description where the two disagree — the starting description
asks for a soft female vocal, and leaving that in while clearing the lyrics is
the usual way a track meant to be instrumental comes back sung. `Vocal Details`
is written as a refusal with its four lines given verbatim, and a voice is
banned from every other field by name.

**The section plan is transcribed from the caption, and filtered on the way
out.** The lyrics field is Music 3's structural channel — `normalize_lyrics`
keeps every bracketed tag, lowercases it and puts it in the prompt after
`[start]`, and ComfyUI's own template note says the tags "are the only
executable structural instructions; the lyric text itself only conveys mood". An
instrumental sends that channel empty, which is a fair part of why it is the
case that comes back shortest. `SECTION_PLANNER` fills it with a list like
`[Intro - 12 seconds]`, `[Theme - 40 seconds]`, `[Solo - 35 seconds]`,
`[Outro - 15 seconds]`, summing to the target.

Writing it at node 47 is what makes the plan and the caption the same piece of
music: node 47 reads node 46's output, so the sections in the plan are the ones
the caption described, at the lengths it gave them. The app used to compute this
list from the duration alone, which was exact and generic — a row of identical
blocks, with the caption asked to bend its arrangement to fit them.

The reason it was computed is still true and is now handled at node 48. Whatever
lands in the lyrics field is performed; this app never sees node 47's output,
which reaches the encode node over a link inside ComfyUI; and an LLM asked for
tags and only tags writes "Here is the plan:" often enough that the sentence
would eventually be sung, in the one kind of track that is meant to have no
singing at all. Node 48 is a `RegexReplace` — a ComfyUI built-in, so no new pack
— that deletes every line not opening with a bracket. That is safe here and
nowhere else: a plan is nothing but tags, whereas in a lyric sheet the
unbracketed lines are the song. `finalize` therefore wires the filter into the
plan path only.

*Plan the sections* turns the whole thing off, and appears only when neither the
box nor the lyricist is supplying anything.

#### Length is a target, and the sampler decides the rest

The slider is the **target**: what the caption, the lyric sheet and the section
plan are each written to fill. Nothing carries it to the model as a number —
`max_audio_frames` never reaches the text, and MiniMax's own generation API has
no duration field either, only `max_new_tokens` — so a target exists in this
system exclusively as structure someone was told to write.

`max_duration` is a different quantity: a **decode limit**. ComfyUI's node hands
it to the autoregressive stage, which generates acoustic frames until it emits
its own end token or reaches that limit, whichever lands first — and the latent
is then sized from what was actually produced, which is why a short song is a
short file rather than a long one padded with silence.

The two used to be one control, which punished the run that went right: a
caption landing the song exactly on the target lost its last bar to a cut-off
placed exactly there. `ceilingSeconds` now derives the limit from the target
with about 15% headroom. Unreached headroom costs nothing — those frames are
never generated — and what it buys is the occasional take that runs slightly
long, which is the better failure.

The slider stops at **five minutes**, MiniMax's own claim for the model. The
node would take six (9000 frames at 25 a second), and that gap is what the
headroom lives in.

That leaves two levers, and they are not the ones you would guess:

- **Structure, in the caption.** The director is told the target and asked
  to spend it as a section list — sections in order, each sized in bars, repeats
  or seconds, that takes that long to play. It is explicitly told *not* to state
  the duration as a fact anywhere, because MiniMax's own caption templates carry
  BPM, key, genre and an arrangement and never a running time, so a line saying
  the piece lasts 3:40 is text the model was not trained to act on. Typing a
  length into your own description has the same problem.
- **Top-k, which acts mechanically.** The end-of-song token is an ordinary
  candidate in the same draw as the audio codes: `_sample_c0` takes the top
  `top_k` of the conditioned logits, softmaxes and samples one. So a song ends
  the frame that token happens to come up, and it can only come up on a frame
  where it ranks inside `top_k`. At 25 frames a second a four-minute take is
  6000 draws, so a per-frame stop chance of even 0.03% ends it early more often
  than not — which is why length varies so much between runs of the same prompt,
  and why no amount of caption wording fixes it. Narrowing `top_k` removes the
  candidate instead of shrinking a probability. 20, then 12; below about 10 the
  music flattens.

Since the ending is a draw, it is decided by the seed — so **Reuse seed** on a
take that came back the length you wanted keeps it while you change other
things.

#### The two guidance scales

Music 3 generates in two stages, and each has its own CFG:

| Control | Node input | What it guides |
| --- | --- | --- |
| Caption guidance | `MiniMaxMusic3TextEncode.cfg_scale` | The autoregressive stage that writes the song as tokens — genre, sections, where it ends |
| Sampler CFG | `KSampler.cfg` | The diffusion stage that renders those tokens into audio |

Both ship at 1.7, in this export and in ComfyUI's template, and that coincidence
was once the argument for driving them from one control. It does not survive
reading what they do: raising guidance to hold a length is advice about the
first stage, and carrying the renderer up with it changes how the audio sounds
for no reason anyone asked for. Caption guidance at 2.0–2.5 is worth trying
alongside a lower `top_k`; Sampler CFG is the one to leave alone.

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
also catches the couplings that are invisible in a diff:

- that turbo's LoRA lands on a model it belongs on;
- that each patch still finds something to sit in front of once the switches
  above it have moved the wiring;
- that the 4-step sampler has exactly one `KSamplerSelect` to stand in for, that
  4 is still inside the steps range in both modes, that the loaders its weights
  swap into exist and take the input named, and that a switch it refuses is one
  the workflow actually offers;
- that a pin names a control that exists and holds a value that control accepts
  in both modes;
- that the director bypass names a node something reads, that the prompt node it
  stands in is the one that director takes its `prompt` from, and that the pass
  leaves no link pointing at a node it deleted;
- and that a graph driving a prompt director declares a `duration` or
  `source_seconds` param — the length block is found by param id, so renaming
  one would otherwise drop it from the instruction and the only symptom would be
  shot cut times landing past the end of the video.

Param types available: `text`, `textarea`, `number`, `slider`, `select`,
`toggle`, `seed`, `image`, `video`, `audio`, and `measured` for a value the
browser reads off a loaded clip rather than the user setting it. `group` sets
the section heading and `advanced: true` tucks a control behind that group's
disclosure.

Four more fields on a param, each of which exists for one of the workflows
above:

- **`revealedBy`** keeps a control out of the form until its condition holds —
  the chain of optional reference slots, each waiting on the one before. A bare
  id asks whether that param has a value at all; `{ param, is }` asks whether it
  has one particular value, which is what a control belonging to one option of a
  select needs. A list means all of them have to hold: the reference trim's
  length waits on a track being attached *and* on the trim being set to a
  length, so a stored answer cannot leave it sitting in a form with no track.
- **`hiddenBy`** is the same question backwards, takes the same two forms, and a
  list there means any one of them hides — the music workflow's *Plan the
  sections* is hidden by both the lyrics box and the lyricist, so it appears
  only when neither is supplying words. The asymmetry is deliberate: waiting is
  a chain of things that must be true, standing down is a list of reasons any of
  which is enough. Both are presentation only. A hidden control still submits
  its stored value; what stops it reaching ComfyUI is `finalize`.
- **`pinnedBy`** is the third of that family and the only one that is *not*
  presentation only: while the named param is set, the control shows the pinned
  value, takes no input, and submits that value whatever was stored under it —
  `applyParams` writes it over the submission after coercion, so a number left
  over from an earlier run cannot get past what the form is showing. Reference
  to Video's steps control is pinned to 4 by its reference track, because that
  is the only step count the graph takes one at. The stored value is untouched
  and comes back when the pin lifts.
- **`makes`** is the noun the Generate button uses — `"video"` unless you say
  `"music"`.

On the workflow itself, past `graph` and `params`: `turbo`, `patches` and
`stepSampler` are the modes described [above](#turbo-sageattention-and-spectrum-are-modes-not-more-workflows);
`clipTarget` makes it the destination of one of the hand-off buttons; and
**`directorBypass`** names the rewrite stage a *Send my prompt as written*
switch takes out, which is the [section on that](#sending-a-prompt-unrewritten).
It is the one place a param may declare no `targets` at all, since its whole
effect is that a node stops being in the graph.

**`finalize` is for structural changes params cannot make.** Params write values
into inputs that already exist; `finalize` runs on the cloned graph, with the
resolved values, and can delete nodes and inputs or swap a value for a link. It
is last but one: the director bypass runs after it, because that pass prunes
whatever was only ever shown to the rewrite and `finalize` is still writing to
some of those nodes on its way past.
Both non-obvious cases in this repo are there: reference slots removing their
loaders when unused, and the music graph pointing `lyrics` at the lyricist's
output instead of at a string. The visibility rules above and `finalize` are
deliberately independent — one decides what the form shows, the other decides
what ComfyUI is sent.

The same visibility rules are applied to the record of a past run: a control the
form was hiding took no part in it, so `paramVisible` is shared between the form
and the settings modal. That is what stops a lyric sheet sitting unused in a
hidden box being read back as the words a track was sung with.

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

**History is kept per device** in `localStorage`, with each run's prompt,
settings and result. Only the *reference* is stored, never the video: the file
stays on the ComfyUI box and streams through `/api/media` on demand. Storing
media here would exhaust the few megabytes localStorage allows after a couple of
clips. The trade is that an entry stops playing if ComfyUI's output directory is
cleared.

**The limit is 2 million characters of history, not a number of runs.** A run is
not a fixed size — about 1KB for an ordinary prompt, about 17KB for one written
to the 8000-character maximum — so a flat count was really a storage limit that
moved by a factor of twenty depending on how much you type. The budget holds
around 1800 ordinary generations and degrades the right way: write enormous
prompts and you keep fewer of them, rather than getting a broken write. Anything
still queued or running is kept regardless, because its entry is the only record
of what to poll and what to cancel.

Characters rather than bytes, because that is the unit that matters. An origin
gets about 5MB, but browsers meter it in UTF-16 — two bytes a character — so the
real ceiling is nearer 2.5M characters for everything this app stores. A budget
written as "5MB" would ask for roughly twice the quota and simply be refused.
Unlimited is not on the table either: `localStorage` writes are synchronous and
throw past the quota, and a cap is what keeps the failure "the oldest entries
went" rather than "history silently stopped saving".

Compute is no longer an argument against a long history, though it used to be.
This blob was stringified on every poll tick, so its size was paid every 1.5
seconds for as long as a render ran. A tick that changes nothing now returns the
same array and writes nothing, and the history regroups on the calendar day
rather than on the second — so what is left is a parse on load, a few
milliseconds at this size.

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

Every written field is shown, each under its own heading and with its line
breaks intact — the description, the lyrics, whatever the workflow declares —
rather than only the prompt. **Reuse settings** in that modal loads the lot back
into the form and switches to the workflow that made it, mode switches included,
merged against the workflow *as that mode has it* so a steps value from a turbo
run lands in the turbo range. Not the seed: varying a take is what this is for,
and reproducing one exactly is the button on the result. Nothing is submitted.

That record outlives the workflow that made it. Params get renamed, removed or
added between a run and the reading of it, so the modal labels what the current
definition still recognises and falls back to the raw id for the rest, rather
than dropping values someone is trying to reconstruct from — and the button is
withheld entirely when that workflow is no longer registered, since there would
be nothing to load into.

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
- **A music track's length is not something you set.** The slider is a ceiling
  and the model ends the song where it decides to, so takes vary between runs of
  the same prompt. [Length is a target](#length-is-a-target-and-the-sampler-decides-the-rest)
  covers why and which controls actually move it.
- **The lyricist and the caption director are one API call each.** A music run
  with *Write the lyrics for me* on makes two, and if the host cannot reach the
  API the run fails at that node — on every workflow, unless *Send my prompt as
  written* has taken the rewrite out of the graph, which is the bypass and the
  only one. The lyricist has no such switch: it is already opt-in.

## License

MIT — see [LICENSE](LICENSE).

The workflow graphs under `src/lib/workflows/` are ComfyUI exports and are
covered by the same licence, but the things they *name* are not: the MiniMax H3
and Music 3 weights, the Qwen3-VL text encoder and the custom node packs each
carry their own terms. Check those before redistributing anything built on them.

## Support

If this saved you an afternoon, you can
[buy me a coffee](https://buymeacoffee.com/reticulated). ☕
