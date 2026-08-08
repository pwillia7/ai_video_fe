import type { ParamDef } from "./types";

/**
 * Shared pieces of the MiniMax H3 graphs. Both the text-to-video and
 * image-to-video exports use identical node ids for sampling, encoding and
 * timing, so these builders apply to either.
 */

/**
 * Duration (seconds) -> frame count.
 *
 * `max(5, round(a * fps))` is the raw frame count; the tail snaps it up to the
 * next value congruent to 5 mod 17, which is what this model expects:
 * 5, 22, 39, 56, 73, 90, 107, 124...
 *
 * Both exports hardcode 24 here while exposing fps separately on CreateVideo.
 * That silently breaks the duration: ask for 5 seconds at 60fps and you get
 * 124 frames played at 60, i.e. about 2 seconds. Rebuilding the formula from
 * the chosen fps keeps the requested duration honest at any frame rate.
 */
export const FRAME_EXPRESSION = (fps: number) =>
  `max(5, round(a * ${fps})) + (5 - (max(5, round(a * ${fps})) % 17)) % 17`;

export function promptParam(defaultPrompt: string, help: string): ParamDef {
  return {
    id: "prompt",
    label: "Prompt",
    type: "textarea",
    rows: 10,
    default: defaultPrompt,
    placeholder: "Describe the action, the camera, and the audio.",
    maxLength: 8000,
    help,
    group: "Prompt",
    targets: [{ node: "105:104", input: "prompt" }],
  };
}

export function durationParam(): ParamDef {
  return {
    id: "duration",
    label: "Duration",
    type: "slider",
    default: 5,
    min: 1,
    max: 20,
    step: 0.5,
    unit: "sec",
    help: "Frame count is derived from this and snapped to the nearest length the model accepts, so the result can land slightly long.",
    group: "Output",
    targets: [{ node: "105:111", input: "value" }],
  };
}

export function fpsParam(): ParamDef {
  return {
    id: "fps",
    label: "Frame rate",
    type: "number",
    default: 24,
    min: 8,
    max: 60,
    step: 1,
    unit: "fps",
    help: "Drives both the encoder and the duration-to-frames formula, so the requested duration stays accurate.",
    group: "Output",
    // Two targets, two shapes: the raw number for the encoder, and the number
    // baked into the frame-count formula.
    targets: [
      { node: "105:91", input: "fps" },
      {
        node: "105:107",
        input: "expression",
        transform: (value) => FRAME_EXPRESSION(Number(value)),
      },
    ],
  };
}

export function samplingParams(): ParamDef[] {
  return [
    {
      id: "seed",
      label: "Seed",
      type: "seed",
      default: -1,
      help: "Reuse a seed to reproduce a take. Randomised by default.",
      group: "Sampling",
      targets: [{ node: "105:15", input: "noise_seed" }],
    },
    {
      id: "steps",
      label: "Steps",
      type: "slider",
      default: 20,
      min: 4,
      max: 60,
      step: 1,
      group: "Sampling",
      targets: [{ node: "105:9", input: "steps" }],
    },
    {
      id: "sampler_name",
      label: "Sampler",
      type: "select",
      default: "res_multistep",
      options: [{ value: "res_multistep", label: "res_multistep" }],
      optionsFrom: { node: "105:17", input: "sampler_name" },
      group: "Sampling",
      advanced: true,
      targets: [{ node: "105:17", input: "sampler_name" }],
    },
    {
      id: "scheduler",
      label: "Scheduler",
      type: "select",
      default: "simple",
      options: [{ value: "simple", label: "simple" }],
      optionsFrom: { node: "105:9", input: "scheduler" },
      group: "Sampling",
      advanced: true,
      targets: [{ node: "105:9", input: "scheduler" }],
    },
    {
      id: "denoise",
      label: "Denoise",
      type: "slider",
      default: 1,
      min: 0.1,
      max: 1,
      step: 0.05,
      group: "Sampling",
      advanced: true,
      targets: [{ node: "105:9", input: "denoise" }],
    },
  ];
}

export function encodingParams(): ParamDef[] {
  return [
    {
      id: "format",
      label: "Container",
      type: "select",
      default: "auto",
      options: [{ value: "auto", label: "auto" }],
      optionsFrom: { node: "92", input: "format" },
      group: "Encoding",
      advanced: true,
      targets: [{ node: "92", input: "format" }],
    },
    {
      id: "codec",
      label: "Codec",
      type: "select",
      default: "auto",
      options: [{ value: "auto", label: "auto" }],
      optionsFrom: { node: "92", input: "codec" },
      group: "Encoding",
      advanced: true,
      targets: [{ node: "92", input: "codec" }],
    },
  ];
}
