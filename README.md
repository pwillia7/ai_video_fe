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

One control can drive several inputs — `fps` in the reference workflow writes to
both `CreateVideo.fps` and the frame-count formula on `ComfyMathExpression`,
because the duration is computed from the frame rate — without that, changing
fps silently changes how long the clip actually runs.

4. Register it in `src/lib/workflows/index.ts`.
5. Run the validator:

```bash
pnpm check:workflows
```

It resolves every `target` against the graph and fails on anything stale, so a
bad mapping surfaces immediately instead of sending a subtly wrong job to the
GPU. The same check runs on `/api/workflows` and again before every submit.

Param types available: `text`, `textarea`, `number`, `slider`, `select`,
`toggle`, `seed`, `image`. Mark a param `advanced: true` to tuck it behind the disclosure;
`group` sets the section heading.

## The bundled workflows

Both target **MiniMax H3** and produce a video with a generated audio track.
They share sampling, timing and encoding controls via `minimax-common.ts`,
since the two exports use identical node ids for those parts.

| Workflow | Output size comes from |
| --- | --- |
| `minimax-h3` — text to video | Aspect ratio + megapixels (`ResolutionSelector`) |
| `minimax-h3-i2v` — image to video | The uploaded image, rescaled by `ImageScaleToTotalPixels` |

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

Two things about that graph are easy to get wrong:

- **Node 115 (`ResolutionSelector`) is orphaned.** Width and height come from
  `GetImageSize` reading the scaled upload, so 115's outputs go nowhere.
  Exposing its aspect ratio or megapixels would give you controls that do
  nothing, so they are deliberately absent. The node is kept so the graph stays
  a faithful copy of the export — ComfyUI only executes what an output depends
  on, so it costs nothing.
- **`image_megapixels` is the real resolution control**, because the video
  inherits the dimensions of the rescaled image.

### Audio

Both graphs decode an audio track into `CreateVideo`, so they set
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

## Leaving a generation running

Two things make it safe to walk away.

**The job survives a reload.** The active `promptId` is kept in `localStorage`
and re-attached on mount, so closing the tab or refreshing puts you back on the
progress bar — or straight onto the finished video. Outputs are not stored, only
the id, so results are always re-derived from `/api/status` rather than trusting
a stale local copy. A restored job that ComfyUI no longer recognises is dropped
quietly: that means the server restarted and lost its history, not that anything
failed.

**Desktop notifications.** The bell in the header opts in (the permission prompt
has to be tied to a click, which is why it is a button). A notification fires
when a run finishes or fails, and only while the tab is hidden — if you are
watching the progress bar already, it would just be noise.

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
- **No history.** Results live until the next run. Persisting them would mean
  storage (Vercel Blob) and a decision about retention.
- **One video at a time in the UI**, though ComfyUI will happily queue more.
