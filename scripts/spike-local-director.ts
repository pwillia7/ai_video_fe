/**
 * Spike: can the ComfyUI box run the prompt director itself?
 *
 * Queues CLIPLoader → TextGenerate → PreviewAny with one of the real directors
 * and reports what came back, how long it took, and the peak VRAM the box saw
 * while it ran. Not part of the app — it exists to answer the questions the
 * local-director design depends on before any of that design is written.
 *
 *   pnpm tsx scripts/spike-local-director.ts <clip file> [--image <input file>] [--prompt "..."] [--type ltxv] [--seed N] [--max N]
 *
 * Needs COMFY_URL (and COMFY_API_TOKEN if the box is behind ComfyUI-Login).
 */
import { readFileSync } from "node:fs";
import { IMAGE_DIRECTOR, TEXT_DIRECTOR } from "../src/lib/workflows/minimax-common";

function loadEnv(): void {
  try {
    for (const line of readFileSync(".env.local", "utf8").split("\n")) {
      const match = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
      if (match && process.env[match[1]] === undefined) {
        process.env[match[1]] = match[2].replace(/^["']|["']$/g, "");
      }
    }
  } catch {
    // No .env.local — the environment has to carry it.
  }
}

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

loadEnv();
const base = process.env.COMFY_URL?.replace(/\/$/, "");
if (!base) throw new Error("COMFY_URL is not set");
const headers: Record<string, string> = { "Content-Type": "application/json" };
if (process.env.COMFY_API_TOKEN) headers.Authorization = `Bearer ${process.env.COMFY_API_TOKEN}`;

const clip = process.argv[2];
if (!clip || clip.startsWith("--")) throw new Error("usage: spike-local-director.ts <clip file> [--image f] [--prompt p]");
const image = arg("image");
const userPrompt =
  arg("prompt") ??
  "Two men in a bare-knuckle fight in an empty parking garage at night. One lands a brutal hook, the other drops, blood on the concrete. The winner spits and says: 'Stay down.'";
const seed = Number(arg("seed") ?? Math.floor(Math.random() * 2 ** 31));
const maxLength = Number(arg("max") ?? 2048);

// 0.33.0's TextGenerate has no system_prompt input, so the director rides in
// the user turn ahead of what was typed. Newer ComfyUI has the input.
const director = image ? IMAGE_DIRECTOR : TEXT_DIRECTOR;
const prompt = `${director.trim()}\n\nThe finished video is 10 seconds long.\n\n---\n\nUSER IDEA:\n${userPrompt}`;

const graph: Record<string, { class_type: string; inputs: Record<string, unknown> }> = {
  "1": { class_type: "CLIPLoader", inputs: { clip_name: clip, type: arg("type") ?? "ltxv" } },
  "2": {
    class_type: "TextGenerate",
    inputs: {
      clip: ["1", 0],
      prompt,
      max_length: maxLength,
      sampling_mode: "on",
      "sampling_mode.temperature": 0.7,
      "sampling_mode.top_k": 64,
      "sampling_mode.top_p": 0.95,
      "sampling_mode.min_p": 0.05,
      "sampling_mode.repetition_penalty": 1.05,
      "sampling_mode.seed": seed,
      thinking: false,
      use_default_template: true,
      ...(image ? { image: ["3", 0] } : {}),
    },
  },
  ...(image ? { "3": { class_type: "LoadImage", inputs: { image } } } : {}),
  "4": { class_type: "PreviewAny", inputs: { source: ["2", 0] } },
};

async function stats(): Promise<{ free: number; total: number }> {
  const response = await fetch(`${base}/system_stats`, { headers });
  const body = (await response.json()) as { devices: Array<{ vram_free: number; vram_total: number }> };
  return { free: body.devices[0].vram_free, total: body.devices[0].vram_total };
}

const gb = (bytes: number) => (bytes / 1024 ** 3).toFixed(1);

const before = await stats();
console.log(`VRAM before: ${gb(before.total - before.free)} / ${gb(before.total)} GB used`);

const started = Date.now();
const queued = await fetch(`${base}/prompt`, {
  method: "POST",
  headers,
  body: JSON.stringify({ prompt: graph }),
});
const queuedBody = (await queued.json()) as { prompt_id?: string; error?: unknown; node_errors?: unknown };
if (!queued.ok || !queuedBody.prompt_id) {
  console.error("Rejected:", JSON.stringify(queuedBody, null, 2));
  process.exit(1);
}

let peakUsed = before.total - before.free;
interface HistoryEntry {
  status?: { status_str: string; messages?: unknown[] };
  outputs?: Record<string, { text?: string[] }>;
}
let entry: HistoryEntry | undefined;
while (!entry) {
  await new Promise((resolve) => setTimeout(resolve, 1000));
  const now = await stats();
  peakUsed = Math.max(peakUsed, now.total - now.free);
  const history = (await (await fetch(`${base}/history/${queuedBody.prompt_id}`, { headers })).json()) as Record<string, HistoryEntry | undefined>;
  const candidate = history[queuedBody.prompt_id];
  if (candidate?.status && candidate.status.status_str !== "running") entry = candidate;
}
if (!entry) throw new Error("unreachable");
const seconds = (Date.now() - started) / 1000;
const after = await stats();

const text = entry.outputs?.["4"]?.text?.join("") ?? "";
console.log(`Status: ${entry.status?.status_str}  seed ${seed}  ${seconds.toFixed(1)}s`);
console.log(`VRAM peak: ${gb(peakUsed)} GB   after: ${gb(after.total - after.free)} GB`);
console.log(`Output: ${text.split(/\s+/).filter(Boolean).length} words`);
if (entry.status?.status_str !== "success") console.log(JSON.stringify(entry.status?.messages, null, 2));
console.log("\n" + text);
