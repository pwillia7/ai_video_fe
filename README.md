# Soran’t

A small Next.js app for driving video generation on a ComfyUI instance. Deploys
to Vercel; the ComfyUI box stays where it is.

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

## Setup

```bash
pnpm install
cp .env.example .env.local   # already created with your endpoint
pnpm dev
```

`.env.local`:

| Variable | Purpose |
| --- | --- |
| `COMFY_URL` | Base URL of ComfyUI, no trailing slash. Required. |
| `COMFY_API_TOKEN` | Token for the ComfyUI-Login node. See the escaping warning below. |
| `APP_ACCESS_TOKEN` | Optional shared secret. When set, every `/api/*` call needs it and the UI asks for it once. |
| `GENERATION_TIMEOUT_SECONDS` | How long the UI waits before giving up. Default 1800. |
| `COMFY_BASIC_AUTH` | Optional `user:password` if ComfyUI sits behind basic auth. |
| `COMFY_AUTH_HEADER_NAME` / `_VALUE` | Optional custom auth header. |

## ComfyUI-Login authentication

Set up for [liusida/ComfyUI-Login](https://github.com/liusida/ComfyUI-Login). Every
outbound call carries `Authorization: Bearer <COMFY_API_TOKEN>`. The token value is
the bcrypt hash the node prints to the ComfyUI console when you set a password.

The Bearer header is used rather than the `?token=` query form the README also
offers, because a bcrypt hash contains `/` and `+` that need URL escaping, and
because query strings land in access logs.

### The `$` escaping trap

The token starts with `$2b$`, and dotenv treats `$2b` as a variable reference.
Pasted raw into `.env.local` it is silently blanked out, and you get a confusing
auth failure with a token that *looks* correct in the file. Escape every `$`:

```bash
# console shows: $2b$12$AbCdEf...
COMFY_API_TOKEN=\$2b\$12\$AbCdEf...
```

Values set in the Vercel dashboard or via `vercel env add` are literal — do **not**
escape them there.

`comfyApiToken()` logs a warning if the token does not start with `$2`, which is
the signature of exactly this mistake.

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

Verified against a mock reproducing all four cases, and then against the live
instance with the login node enabled: unauthenticated calls redirect to
`/login`, a wrong token is rejected, and the correct token authenticates.

Note this build of the login node returns **302 for every `Accept` header**,
including `application/json` — newer source returns 401 JSON to non-HTML
clients. Following that redirect yields `200 text/html`, which is precisely the
`Unexpected token <` the redirect guard exists to prevent.

### If a correct token is still rejected

Bearer auth sits behind a CORS condition in the plugin:

```python
if args.enable_cors_header is None or args.enable_cors_header == '*' or args.enable_cors_header == request.headers.get('Origin'):
```

Server-side `fetch` sends no `Origin` header, so starting ComfyUI with
`--enable-cors-header <specific-origin>` makes the Bearer check unreachable and
a valid token fails. Drop the flag or set it to `*`. (Not currently an issue on
this instance — verified.)

## Putting ComfyUI behind HTTPS (Tailscale Funnel)

As shipped, `COMFY_URL` is plain HTTP. Nothing serves TLS on 8443 — that port is
forwarded straight to ComfyUI's aiohttp listener, and the number `8443` implies
nothing on its own. The app works regardless, because all ComfyUI traffic is
server-side and mixed-content rules do not apply; what plain HTTP costs you is
confidentiality of the Bearer token and your prompts in transit.

[Tailscale Funnel](https://tailscale.com/docs/features/tailscale-funnel) fixes
that and lets you close the forwarded port entirely. Funnel routes by SNI and
terminates TLS **on your own machine**, so Tailscale relays the encrypted stream
without decrypting it.

> **Funnel is public, not private.** It puts the service on the open internet by
> name — that is the point, since Vercel's functions are not on your tailnet.
> `COMFY_API_TOKEN` is still doing the access control. (Tailscale *Serve* is the
> tailnet-private variant, which Vercel could not reach.)

Run these on the **Windows box** that hosts ComfyUI:

1. Find the port ComfyUI actually listens on locally. Publicly it is 8443, but
   that is your router's forward — ComfyUI's own default is `8188`.

2. Install Tailscale for Windows and sign in.

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

9. Now close the 8443 port-forward on your router. Funnel is outbound-only, so
   nothing needs to be exposed inbound any more — this is the bigger win.

To undo: `tailscale funnel --https=443 localhost:8188 off`.

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
another baked into a formula string.

4. Register it in `src/lib/workflows/index.ts`.
5. Run the validator:

```bash
pnpm check:workflows
```

It resolves every `target` against the graph and fails on anything stale, so a
bad mapping surfaces immediately instead of sending a subtly wrong job to the
GPU. The same check runs on `/api/workflows` and again before every submit.

Param types available: `text`, `textarea`, `number`, `slider`, `select`,
`toggle`, `seed`, `image`, `video`. Mark a param `advanced: true` to tuck it behind the disclosure;
`group` sets the section heading.

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

### The prompt is rewritten before the model sees it

Every graph runs what you type through an LLM first. A
`PrimitiveStringMultiline` node holds the raw input, an `OAIAPI_ChatCompletion`
node expands it into a shot-by-shot description, and only that output reaches
the video node. The image and reference workflows also hand their uploads to
the rewrite, so it can describe what is actually in frame.

**Which system prompt depends on the workflow**, and the difference is not
cosmetic. The three graphs that invent a scene use `PROMPT_DIRECTOR`, which
fills in everything you left unsaid — camera, performance, dialogue, sound
design — from a one-line idea. The two that start from a clip do not, because
that behaviour is actively wrong once a source exists, and they do not agree
with each other either:

- **Remix** runs `REMIX_DIRECTOR`. What you type is a *delta*, and every detail
  the rewrite invents overwrites something the source already decided. So it
  inverts the default — preserve by instruction, and never write replacement
  dialogue merely because someone is speaking, since the clip's own audio
  already holds the words. How much it changes is proportional to how much you
  asked for: a costume note reaches the costume, while "turn this into
  claymation" is licensed to re-render nearly every surface. Sound moves with
  the world — new weather, room or medium changes what the scene sounds like —
  while the words, voices and music hold unless asked otherwise.
- **Extend** runs `EXTEND_DIRECTOR`. Nothing about the source changes there;
  time moves forward, and what you type is what happens *next*. Most of it is
  spent on the seam: no establishing shot, no fade, no cut, no resetting
  characters into neutral poses, and motion already underway carried through
  the join. It also holds the previous clip's dialogue to the previous clip.

All three live in `minimax-common.ts` and are workflow data: treat them as data,
not prose to tidy.

Two are verbatim from the ComfyUI exports. `REMIX_DIRECTOR` is **not** — it was
pinned near "preserve everything", roughly Sora's mildest remix setting, where
its own remix ran a dial from there up to replacing whole buildings. Held that
low, a sweeping request came back as the source with a wash over it, and the
soundtrack never moved even when the world it was recorded in did. The edits are
marked in the file. If the ComfyUI workflow is re-exported over it they will be
lost, so the better fix is to make the same edit on the ComfyUI side.

Two consequences:

- **The prompt param targets the input node, not the video node.** On these
  graphs `MiniMaxH3ImageToVideo.prompt` is a link, not a value. Writing to it
  would be overwritten at execution time and the user's text would vanish.
- **`api_key` is `"-"` in every export.** The ComfyUI host supplies the real
  key; nothing about it lives in this app. If that host cannot reach the API,
  the rewrite node fails and takes the whole job with it — there is no bypass
  wired into these graphs.

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

## How deploys happen

The GitHub repo is connected to the Vercel project, so:

- **Push to `main` → production**, live at `ai-video-fe.vercel.app`
- **Push to any other branch → a preview deployment**, protected by Vercel
  Authentication (a Vercel login is required to view it)

Production is publicly reachable and gated only by `APP_ACCESS_TOKEN`, because
Vercel Authentication cannot cover production deployments on the Pro plan. A
push to `main` is therefore a public release — work on a branch and merge when
you mean it.

`vercel deploy` and `vercel deploy --prod` still work for deploying the working
tree directly, without a commit.

## Deploying manually

```bash
vercel link
vercel env add COMFY_URL production          # http://your-comfyui-host:8188
vercel env add COMFY_API_TOKEN production    # the $2b$... hash, unescaped here
vercel env add APP_ACCESS_TOKEN production   # openssl rand -hex 32
vercel deploy --prod
```

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
| `pnpm check:workflows` | Validate param→graph mappings |

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
