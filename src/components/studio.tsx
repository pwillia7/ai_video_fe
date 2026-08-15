"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { ConnectionPill } from "@/components/connection-pill";
import { NotifyToggle } from "@/components/notify-toggle";
import { GenerationStage } from "@/components/generation-stage";
import { ParamForm } from "@/components/param-form";
import { SettingsModal } from "@/components/settings-modal";
import { ThemeToggle } from "@/components/theme-toggle";
import { TipsModal } from "@/components/tips-modal";
import { tipsFor } from "@/lib/workflows/tips";
import { TokenGate } from "@/components/token-gate";
import { ModelOptions } from "@/components/model-options";
import { TurboSwitch } from "@/components/turbo-switch";
import { patchSuppressed } from "@/lib/workflows/patches";
import { Button } from "@/components/ui/button";
import { Panel, PanelHeader } from "@/components/ui/panel";
import { WorkflowPicker } from "@/components/workflow-picker";
import { GenerationsPanel } from "@/components/generations-panel";
import { SorantMark } from "@/components/sorant-logo";
import { useJobs } from "@/hooks/use-jobs";
import { isActive, type Job } from "@/lib/jobs";
import { api, ApiError, getToken } from "@/lib/client";
import {
  clampValues,
  hydrateAll,
  hydratePatches,
  hydrateTurbo,
  mergeWithDefaults,
  readStoredLowVram,
  writeStoredLowVram,
  writeStoredParams,
  writeStoredPatches,
  writeStoredTurbo,
} from "@/lib/param-storage";
import { workflowLabel } from "@/lib/workflows/modes";
import { effectiveWorkflow } from "@/lib/workflows/turbo";
import {
  CLIP_ACTIONS,
  defaultValuesFor,
  pinnedValues,
  type ClipAction,
  type ParamValue,
  type WorkflowSummary,
} from "@/lib/workflows/types";

interface ConfigPayload {
  authRequired: boolean;
  generationTimeoutSeconds: number;
}

/**
 * What the note above the form says once a file has been loaded into it. The
 * hand-offs leave the form in genuinely different states — Remix arrives with
 * the source's prompt in place, Extend arrives wanting a new one, Create video
 * arrives with a reference that is not the picture — so the note has to say
 * which of them happened.
 */
const CLIP_NOTICE: Record<ClipAction, { verb: string; detail: string }> = {
  illustrate: {
    verb: "Scoring",
    detail:
      "The track is loaded as a reference below, and pins the run to 4 steps. Add a picture if you want one, say what should be on screen, then generate — the video is the length of its own control, not the track's.",
  },
  remix: {
    verb: "Remixing",
    detail:
      "The clip is loaded as the reference below — change anything you like, then generate.",
  },
  extend: {
    verb: "Extending",
    detail:
      "The clip is loaded below. Say what happens next, then generate — the result is the clip plus what you asked for.",
  },
};

type Boot =
  | { kind: "loading" }
  | { kind: "locked" }
  | { kind: "failed"; message: string }
  | {
      kind: "ready";
      workflows: WorkflowSummary[];
      timeoutSeconds: number;
      problems?: string[];
    };

export function Studio() {
  const [boot, setBoot] = useState<Boot>({ kind: "loading" });

  const load = useCallback(async () => {
    setBoot({ kind: "loading" });
    try {
      const config = await api<ConfigPayload>("/api/config");
      if (config.authRequired && !getToken()) {
        setBoot({ kind: "locked" });
        return;
      }

      const { workflows, problems } = await api<{
        workflows: WorkflowSummary[];
        problems?: string[];
      }>("/api/workflows");

      setBoot({
        kind: "ready",
        workflows,
        problems,
        timeoutSeconds: config.generationTimeoutSeconds,
      });
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 401) {
        setBoot({ kind: "locked" });
        return;
      }
      setBoot({
        kind: "failed",
        message:
          cause instanceof ApiError
            ? cause.message
            : "Could not load workflows.",
      });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (boot.kind === "locked") return <TokenGate onUnlocked={load} />;

  if (boot.kind === "loading") {
    return (
      <main className="grid min-h-dvh place-items-center">
        <p className="text-[13px] text-fg-subtle">Loading…</p>
      </main>
    );
  }

  if (boot.kind === "failed") {
    return (
      <main className="grid min-h-dvh place-items-center p-6">
        <div className="max-w-sm text-center">
          <p className="text-sm font-medium text-fg">Could not start</p>
          <p className="mt-1 mb-5 text-[13px] leading-relaxed text-fg-muted">
            {boot.message}
          </p>
          <Button onClick={() => void load()}>Retry</Button>
        </div>
      </main>
    );
  }

  return (
    <Workbench workflows={boot.workflows} problems={boot.problems} />
  );
}

function Workbench({
  workflows,
  problems,
}: {
  workflows: WorkflowSummary[];
  problems?: string[];
}) {
  const [selectedId, setSelectedId] = useState(workflows[0]?.id ?? "");
  const jobs = useJobs();

  // Both of these are read lazily rather than in an effect: Workbench only
  // mounts after the client-side load, so there is no server render to
  // mismatch, and an effect would flash the defaults first. Read together
  // because the values depend on the modes — a stored steps value is merged
  // against whichever range the mode it was saved under puts it in.
  const [initial] = useState(() => {
    const turbo = hydrateTurbo(workflows);
    return {
      turbo,
      patches: hydratePatches(workflows),
      values: hydrateAll(workflows, turbo),
    };
  });

  /** Which workflows are in turbo. Only ever keyed by ones that offer it. */
  const [turboByWorkflow, setTurboByWorkflow] = useState(initial.turbo);

  /**
   * Which single-node switches are on, per workflow. Kept apart from turbo
   * rather than folded into one map of mode objects because the two are
   * independent — Remix offers the patches and not turbo — and because turbo is
   * one boolean where this is a list.
   */
  const [patchesByWorkflow, setPatchesByWorkflow] = useState(initial.patches);

  /**
   * Turbo's low-VRAM path, for every workflow at once — it answers a question
   * about the GPU rather than about the shot, and the answer does not change
   * between graphs. Read lazily for the same reason as the modes above.
   */
  const [lowVram, setLowVram] = useState(readStoredLowVram);

  // Values are kept per workflow so switching to compare settings and coming
  // back does not throw away what you typed, and persisted so a reload does
  // not either.
  const [valuesByWorkflow, setValuesByWorkflow] = useState<
    Record<string, Record<string, ParamValue>>
  >(initial.values);

  useEffect(() => {
    writeStoredParams(valuesByWorkflow);
  }, [valuesByWorkflow]);

  useEffect(() => {
    writeStoredTurbo(turboByWorkflow);
  }, [turboByWorkflow]);

  useEffect(() => {
    writeStoredPatches(patchesByWorkflow);
  }, [patchesByWorkflow]);

  useEffect(() => {
    writeStoredLowVram(lowVram);
  }, [lowVram]);

  // A clock that only ticks while something is running, so elapsed times
  // advance smoothly between poll results without re-rendering an idle page.
  const [now, setNow] = useState(() => Date.now());
  const hasActive = jobs.jobs.some(isActive);
  useEffect(() => {
    if (!hasActive) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [hasActive]);

  const picked = useMemo(
    () => workflows.find((workflow) => workflow.id === selectedId),
    [workflows, selectedId],
  );

  const turboOn = Boolean(turboByWorkflow[selectedId]);
  const patchesOn = useMemo(
    () => patchesByWorkflow[selectedId] ?? [],
    [patchesByWorkflow, selectedId],
  );
  const modes = useMemo(
    () => ({ turbo: turboOn, patches: patchesOn }),
    [turboOn, patchesOn],
  );

  /**
   * The workflow as the switch has it: same everything, except that turbo
   * retunes the steps control and carries its own estimate. Everything below
   * works from this rather than from the registry entry, so nothing else has
   * to know the mode exists.
   */
  const selected = useMemo(
    () => (picked ? effectiveWorkflow(picked, turboOn) : undefined),
    [picked, turboOn],
  );

  const values = valuesByWorkflow[selectedId] ?? {};

  /**
   * The same values as the server will resolve them: a pinned control submits
   * its pinned value rather than whatever is stored under it, and anything
   * deciding what the run *is* — which switches its step count refuses — has to
   * read that number and not the stored one. See `pinnedValues`.
   */
  const runValues = useMemo(
    () => (selected ? pinnedValues(selected.params, values) : values),
    [selected, values],
  );

  /**
   * The modes as this run would actually have them, for everywhere a run is
   * *named* — the panel hint and the history entry. A switch the step count
   * refuses is still on and still remembered, but it is not part of what this
   * generation is, and naming it there would be the one place the app said so.
   * `modes` is what gets submitted, and stays what was asked for.
   */
  const runModes = useMemo(
    () => ({
      turbo: turboOn,
      patches: patchesOn.filter((id) => {
        const patch = selected?.patches.find((candidate) => candidate.id === id);
        return !patch || !patchSuppressed(patch, runValues);
      }),
    }),
    [turboOn, patchesOn, selected, runValues],
  );

  /**
   * Switching mode moves the steps range under a value that was valid in the
   * other one, so the values are brought back inside the new ranges as the
   * mode changes rather than left for the server to reject on submit.
   */
  const setTurbo = useCallback(
    (on: boolean) => {
      if (!picked?.turbo) return;
      setTurboByWorkflow((previous) => ({ ...previous, [selectedId]: on }));
      setValuesByWorkflow((previous) => ({
        ...previous,
        [selectedId]: clampValues(
          effectiveWorkflow(picked, on),
          previous[selectedId] ?? {},
        ),
      }));
    },
    [picked, selectedId],
  );

  /**
   * Nothing to clamp here, unlike turbo: a patch retunes no control, so turning
   * one on cannot leave a value outside a range.
   *
   * The stored list is rebuilt from the workflow's own order rather than by
   * appending, so it reads the same way the switches do and does not depend on
   * the order they were clicked.
   */
  const setPatch = useCallback(
    (id: string, on: boolean) => {
      if (!picked) return;
      setPatchesByWorkflow((previous) => {
        const current = previous[selectedId] ?? [];
        const wanted = on
          ? [...current, id]
          : current.filter((other) => other !== id);
        return {
          ...previous,
          [selectedId]: picked.patches
            .filter((patch) => wanted.includes(patch.id))
            .map((patch) => patch.id),
        };
      });
    },
    [picked, selectedId],
  );

  const setValue = useCallback(
    (id: string, value: ParamValue) => {
      setValuesByWorkflow((previous) => ({
        ...previous,
        [selectedId]: { ...previous[selectedId], [id]: value },
      }));
    },
    [selectedId],
  );

  /**
   * Swapping the clip out by hand ends the lineage — whatever is generated
   * next came from a different source, so claiming otherwise in the history
   * would be worse than showing nothing.
   */
  const onParamChange = useCallback(
    (id: string, value: ParamValue) => {
      if (selected?.clipTarget?.sourceParam === id) {
        setClipSource(null);
        setClipNotice(null);
      }
      setValue(id, value);
    },
    [selected, setValue],
  );

  const resetToDefaults = useCallback(() => {
    if (!selected) return;
    // The persistence effect writes this straight back out, so the stored copy
    // is reset too rather than reappearing on the next load.
    setValuesByWorkflow((previous) => ({
      ...previous,
      [selectedId]: defaultValuesFor(selected),
    }));
  }, [selected, selectedId]);

  // Where each hand-off sends a finished clip, if anywhere. Found by
  // declaration rather than by id so the buttons follow whatever the registry
  // offers; first declaration of an action wins.
  const clipWorkflows = useMemo(() => {
    const byAction = new Map<ClipAction, WorkflowSummary>();
    for (const workflow of workflows) {
      const action = workflow.clipTarget?.action;
      if (action && !byAction.has(action)) byAction.set(action, workflow);
    }
    return byAction;
  }, [workflows]);

  // Paired with what each destination reads, so the result view can offer a
  // track's hand-offs on a track and a clip's on a clip.
  const offeredActions = useMemo(
    () =>
      CLIP_ACTIONS.flatMap((action) => {
        const target = clipWorkflows.get(action)?.clipTarget;
        return target ? [{ action, accepts: target.accepts }] : [];
      }),
    [clipWorkflows],
  );

  /** The hand-off whose copy is in flight, so only one runs at a time. */
  const [sending, setSending] = useState<ClipAction | null>(null);
  const [clipError, setClipError] = useState<string | null>(null);
  /** What was loaded and how, for the notice above the form. */
  const [clipNotice, setClipNotice] = useState<{
    action: ClipAction;
    label: string;
  } | null>(null);
  /**
   * Which generation the loaded clip came from, so the run it produces can be
   * shown under it in the history. Held past submit on purpose: three
   * variations on one remix are three children of the same source.
   */
  const [clipSource, setClipSource] = useState<{
    action: ClipAction;
    promptId: string;
  } | null>(null);

  const stageRef = useRef<HTMLDivElement>(null);
  const settingsRef = useRef<HTMLElement>(null);

  /**
   * Send a finished generation into the workflow that takes it as a source —
   * Remix to rebuild a clip, Extend to carry on from one, Create video to build
   * a video around a track.
   *
   * The file itself is copied server-side (see /api/remix, which serves all
   * three): ComfyUI keeps outputs and loader inputs in separate directories, so
   * it has to move between them before a LoadVideo or LoadAudio node can see it.
   *
   * Nothing is submitted. This only fills the form in — the point is to open
   * the next generation ready to edit.
   */
  const sendClip = useCallback(
    async (job: Job, action: ClipAction) => {
      const target = clipWorkflows.get(action);
      if (!target?.clipTarget || sending) return;
      const { sourceParam, carry } = target.clipTarget;

      const output = job.outputs[0];
      if (!output) return;

      setSending(action);
      setClipError(null);
      try {
        const { ref } = await api<{ ref: string }>("/api/remix", {
          method: "POST",
          body: JSON.stringify({
            filename: output.filename,
            subfolder: output.subfolder,
            type: output.type,
          }),
        });

        setValuesByWorkflow((previous) => {
          const next = { ...previous[target.id], [sourceParam]: ref };

          // Carry across whatever this destination asked for, so the new run
          // starts out matching the generation it came from rather than
          // reverting to whatever was last used here.
          for (const param of target.params) {
            if (!carry?.includes(param.id)) continue;
            const carried = job.resolved?.[param.id];
            // A type mismatch means the source workflow used the id for
            // something else — take the target's default over nonsense.
            if (carried === undefined) continue;
            if (typeof carried !== typeof param.default) continue;
            next[param.id] = carried;
          }

          return { ...previous, [target.id]: next };
        });

        setSelectedId(target.id);
        setClipNotice({
          action,
          label: job.prompt.trim() || job.workflowName,
        });
        setClipSource({ action, promptId: job.promptId });

        // On mobile the form sits above the stage the button was pressed in,
        // so without this the settings it just filled in are off-screen.
        if (window.matchMedia("(max-width: 1023px)").matches) {
          requestAnimationFrame(() =>
            settingsRef.current?.scrollIntoView({
              behavior: "smooth",
              block: "start",
            }),
          );
        }
      } catch (cause) {
        setClipError(
          cause instanceof ApiError
            ? cause.message
            : "Could not set that clip up as a source.",
        );
      } finally {
        setSending(null);
      }
    },
    [clipWorkflows, sending],
  );

  /**
   * Load a past generation's settings back into the form, and switch to the
   * workflow it was made with.
   *
   * Everything it was run with, not only the values: the mode switches are as
   * much a part of how a take came out as any control, and the steps range
   * depends on turbo, so the values are merged against the workflow *as that
   * mode has it*. `mergeWithDefaults` does the rest of the work — a param since
   * renamed, removed, or changed type is dropped rather than restored as
   * nonsense, which is the same protection stored settings get on load.
   *
   * The seed is deliberately not restored. Reusing settings is how a take gets
   * varied; reproducing one exactly is a separate act with its own button on
   * the result, and rolling the seed back here would silently pin every rerun
   * to the old noise.
   *
   * Nothing is submitted. As with the clip hand-offs, this only fills the form
   * in and leaves the run to the user.
   */
  const reuseSettings = useCallback(
    (job: Job) => {
      const target = workflows.find(
        (workflow) => workflow.id === job.workflowId,
      );
      if (!target) return;

      const turbo = Boolean(job.turbo) && Boolean(target.turbo);
      const restored = mergeWithDefaults(
        effectiveWorkflow(target, turbo),
        job.resolved,
      );
      for (const param of target.params) {
        if (param.type === "seed") restored[param.id] = param.default;
      }

      setValuesByWorkflow((previous) => ({
        ...previous,
        [target.id]: restored,
      }));
      if (target.turbo) {
        setTurboByWorkflow((previous) => ({ ...previous, [target.id]: turbo }));
      }
      // Only the switches this workflow still offers: one since removed or
      // renamed would be sent on the next run and refused by the server over a
      // switch the form never showed.
      setPatchesByWorkflow((previous) => ({
        ...previous,
        [target.id]: target.patches
          .filter((patch) => job.patches?.includes(patch.id))
          .map((patch) => patch.id),
      }));
      setSelectedId(target.id);

      // Same reason as the clip hand-off: on mobile the form sits above the
      // stage this was opened from, so the settings it just filled in would
      // otherwise be off-screen.
      if (window.matchMedia("(max-width: 1023px)").matches) {
        requestAnimationFrame(() =>
          settingsRef.current?.scrollIntoView({
            behavior: "smooth",
            block: "start",
          }),
        );
      }
    },
    [workflows],
  );

  const [tipsOpen, setTipsOpen] = useState(false);
  const tips = selected ? tipsFor(selected.id, modes) : undefined;

  // Which generation's settings are on screen, by id rather than by value: a
  // poll can replace the job object mid-view, and holding the object would
  // freeze the modal on a stale copy.
  const [settingsForId, setSettingsForId] = useState<string | null>(null);

  // Closing the panel when the workflow changes avoids showing one workflow's
  // advice under another's name.
  useEffect(() => {
    setTipsOpen(false);
  }, [selectedId]);

  /** Nothing to restore when the form already matches the defaults. */
  const isDefaults = useMemo(() => {
    if (!selected) return true;
    const defaults = defaultValuesFor(selected);
    return Object.keys(defaults).every((key) => values[key] === defaults[key]);
  }, [selected, values]);

  // Which generation the stage is showing. Follows the newest submission so a
  // fresh run takes over the canvas, but stays put if you pick an older one.
  const [viewedId, setViewedId] = useState<string | null>(null);
  const newestId = jobs.jobs[0]?.promptId ?? null;
  useEffect(() => {
    if (newestId) setViewedId(newestId);
  }, [newestId]);

  const viewedJob =
    jobs.jobs.find((job) => job.promptId === viewedId) ?? jobs.jobs[0] ?? null;

  // Resolved fresh each render, so the modal follows the job it is showing —
  // and closes itself if that entry is cleared from history while open.
  const settingsJob =
    jobs.jobs.find((job) => job.promptId === settingsForId) ?? null;

  const fieldError = useMemo(() => {
    if (!jobs.submitError || !jobs.submitErrorField) return null;
    return { field: jobs.submitErrorField, message: jobs.submitError };
  }, [jobs.submitError, jobs.submitErrorField]);

  const submit = useCallback(() => {
    if (!selected || jobs.submitting) return;
    void jobs.submit(selected, values, {
      ...modes,
      lowVram,
      // Only meaningful on the workflow the clip was actually loaded into, and
      // only for the hand-off that put it there.
      derivedFrom:
        selected.clipTarget && clipSource?.action === selected.clipTarget.action
          ? clipSource.promptId
          : undefined,
    });
    // The form has been acted on, so the note explaining how it got filled in
    // has served its purpose.
    setClipNotice(null);
    // On mobile the stage sits below the whole settings panel, so submitting
    // from the pinned bar would otherwise give no visible sign of anything
    // happening. Desktop keeps the stage pinned alongside, so leave it alone.
    if (window.matchMedia("(max-width: 1023px)").matches) {
      requestAnimationFrame(() =>
        stageRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }),
      );
    }
  }, [selected, values, jobs, clipSource, modes, lowVram]);

  // Cmd/Ctrl+Enter from anywhere fires the run. Held in a ref so the listener
  // is attached once rather than on every keystroke in the prompt box.
  const submitRef = useRef(submit);
  useEffect(() => {
    submitRef.current = submit;
  }, [submit]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
        event.preventDefault();
        submitRef.current();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // Named after what the selected workflow actually makes: pressing "Generate
  // video" and getting an mp3 is a small lie the app was telling.
  const queueLabel =
    jobs.activeCount > 0
      ? `Queue another (${jobs.activeCount} running)`
      : `Generate ${selected?.makes ?? "video"}`;

  return (
    <div className="min-h-dvh">
      <header
        className="sticky top-0 z-20 border-b border-border-default
          bg-bg/80 backdrop-blur-md"
      >
        <div className="mx-auto flex h-14 max-w-[1400px] items-center gap-2 px-4 sm:gap-3 sm:px-5">
          {/* Decorative: the h1 beside it says the name, and a mark that
              announced it too would have a screen reader read it twice. */}
          <SorantMark aria-hidden="true" className="size-7 shrink-0 text-fg" />
          <h1 className="text-[13px] font-medium tracking-[-0.01em] text-fg">
            {/* Live text rather than the drawn wordmark, so it stays Geist and
                stays selectable. The apostrophe carries the accent — the one
                piece of colour in the header, and the thing the name turns on. */}
            Soran<span className="text-accent">’</span>t
          </h1>
          {/* Secondary label: the first thing to go when space is tight. */}
          <span className="hidden text-[13px] text-fg-subtle sm:inline">
            / ComfyUI
          </span>

          <div className="ml-auto flex shrink-0 items-center gap-2">
            <ConnectionPill />
            <NotifyToggle />
            <ThemeToggle />
          </div>
        </div>
      </header>

      {/* pb-24 on mobile keeps the sticky action bar from covering the last
          control; the bar is not rendered at lg, so the padding goes away. */}
      <main className="mx-auto max-w-[1400px] px-4 pb-24 pt-5 sm:px-5 lg:pb-6 lg:pt-6">
        {problems?.length ? (
          <div
            className="mb-5 rounded-lg border border-warning/40 bg-warning/5 p-3
              text-[12px] leading-relaxed text-warning"
          >
            <p className="font-medium">
              A workflow definition looks out of sync with its graph:
            </p>
            <ul className="mt-1 list-inside list-disc font-mono">
              {problems.map((problem) => (
                <li key={problem}>{problem}</li>
              ))}
            </ul>
          </div>
        ) : null}

        {/*
          minmax(0,1fr) rather than 1fr: a flexible track's automatic minimum
          is min-content, so the widest unwrappable thing in the column sets a
          floor the track cannot go below. The history list is full of them —
          every entry's prompt line is `truncate`, which is white-space:nowrap,
          so its min-content is the whole prompt however long it runs. One long
          prompt was widening this track past the page and scrolling the
          document sideways. Capping the minimum at 0 lets the ellipsis do the
          job it was there for.
        */}
        <div className="grid gap-5 lg:grid-cols-[minmax(320px,380px)_minmax(0,1fr)]">
          {/* min-w-0: a grid item defaults to min-width:auto and would grow
              past its track to fit wide content such as an image preview. */}
          <div className="flex min-w-0 flex-col gap-5">
            <Panel className="rise" padded>
              <PanelHeader
                title="Workflow"
                hint="Preconfigured graphs on the ComfyUI instance."
              />
              <WorkflowPicker
                workflows={workflows}
                turbo={turboByWorkflow}
                patches={patchesByWorkflow}
                selectedId={selectedId}
                onSelect={(id) => {
                  // Choosing a workflow by hand supersedes whatever Remix or
                  // Extend set up, so the note about it goes.
                  setClipNotice(null);
                  setClipSource(null);
                  setSelectedId(id);
                }}
              />
            </Panel>

            {selected ? (
              <Panel
                ref={settingsRef}
                className="rise scroll-mt-20"
                style={{ "--delay": "80ms" } as CSSProperties}
                padded
              >
                <PanelHeader
                  title="Settings"
                  hint={workflowLabel(selected.name, runModes, selected.patches)}
                  action={
                    <div className="flex shrink-0 items-center gap-2">
                      {tips ? (
                        <Button
                          variant="quiet"
                          size="xs"
                          onClick={() => setTipsOpen(true)}
                        >
                          Tips
                        </Button>
                      ) : null}
                      <Button
                        variant="quiet"
                        size="xs"
                        onClick={resetToDefaults}
                        disabled={isDefaults}
                        title={
                          isDefaults
                            ? "Already at the defaults"
                            : "Put every setting on this workflow back to its default"
                        }
                      >
                        Restore defaults
                      </Button>
                    </div>
                  }
                />
                {selected.turbo ? (
                  <TurboSwitch
                    turbo={selected.turbo}
                    on={turboOn}
                    onChange={setTurbo}
                  />
                ) : null}

                <ModelOptions
                  patches={selected.patches}
                  on={patchesOn}
                  values={runValues}
                  onPatchChange={setPatch}
                  turbo={selected.turbo}
                  turboOn={turboOn}
                  lowVram={lowVram}
                  onLowVramChange={setLowVram}
                />

                {clipNotice &&
                selected.clipTarget?.action === clipNotice.action ? (
                  <div
                    className="mb-5 flex items-start gap-3 rounded-lg border border-accent/40
                      bg-accent-subtle/30 p-3 text-[12px] leading-relaxed text-fg-muted"
                  >
                    <span className="min-w-0 flex-1">
                      {CLIP_NOTICE[clipNotice.action].verb}{" "}
                      <span className="text-fg">“{clipNotice.label}”</span>.{" "}
                      {CLIP_NOTICE[clipNotice.action].detail}
                    </span>
                    <Button
                      variant="quiet"
                      size="xs"
                      className="shrink-0"
                      onClick={() => setClipNotice(null)}
                    >
                      Dismiss
                    </Button>
                  </div>
                ) : null}

                {/* Deliberately never disabled: a running generation should not
                    stop you setting up the next one. */}
                <ParamForm
                  params={selected.params}
                  values={values}
                  onChange={onParamChange}
                  fieldError={fieldError}
                />
              </Panel>
            ) : null}
          </div>

          <div
            ref={stageRef}
            /* min-w-0 for the same reason as the left column: without it this
               grid item takes min-width:auto and grows past its track. */
            className="flex min-w-0 scroll-mt-20 flex-col gap-4 lg:sticky lg:top-20 lg:self-start"
          >
            {/* On mobile this lives in the pinned bar at the bottom instead,
                so the primary action is never a scroll away. */}
            <div className="hidden items-center gap-3 lg:flex">
              <Button
                variant="primary"
                size="lg"
                onClick={submit}
                loading={jobs.submitting}
                disabled={!selected}
                className="flex-1 sm:flex-none sm:min-w-44"
              >
                {queueLabel}
              </Button>
              <span className="hidden text-[12px] text-fg-subtle lg:block">
                or press{" "}
                <kbd
                  className="rounded border border-border-default bg-bg-subtle
                    px-1.5 py-0.5 font-mono text-[11px]"
                >
                  ⌘↵
                </kbd>
              </span>
            </div>

            {jobs.submitError && !jobs.submitErrorField ? (
              <div
                className="flex items-start gap-3 rounded-lg border border-danger/40
                  bg-danger/5 p-3 text-[13px] leading-relaxed text-danger"
              >
                <span className="min-w-0 flex-1">{jobs.submitError}</span>
                <Button
                  variant="danger"
                  size="xs"
                  className="shrink-0"
                  onClick={jobs.dismissSubmitError}
                >
                  Dismiss
                </Button>
              </div>
            ) : null}

            {clipError ? (
              <div
                className="flex items-start gap-3 rounded-lg border border-danger/40
                  bg-danger/5 p-3 text-[13px] leading-relaxed text-danger"
              >
                <span className="min-w-0 flex-1">{clipError}</span>
                <Button
                  variant="danger"
                  size="xs"
                  className="shrink-0"
                  onClick={() => setClipError(null)}
                >
                  Dismiss
                </Button>
              </div>
            ) : null}

            <GenerationStage
              job={viewedJob}
              now={now}
              estimateSeconds={viewedJob ? jobs.estimateFor(viewedJob) : null}
              onCancel={(promptId) => void jobs.cancel(promptId)}
              onReuseSeed={(seed) => setValue("seed", seed)}
              clipActions={offeredActions}
              onClipAction={
                offeredActions.length > 0
                  ? (job, action) => void sendClip(job, action)
                  : undefined
              }
              onShowSettings={
                viewedJob
                  ? () => setSettingsForId(viewedJob.promptId)
                  : undefined
              }
              onToggleFavorite={jobs.toggleFavorite}
              busyAction={sending}
            />

            <Panel padded>
              <PanelHeader
                title="Generations"
                hint={
                  jobs.jobs.length > 0
                    ? `${jobs.jobs.length} on this device`
                    : undefined
                }
              />
              <GenerationsPanel
                jobs={jobs.jobs}
                selectedId={viewedJob?.promptId ?? null}
                now={now}
                onSelect={setViewedId}
                onCancel={(promptId) => void jobs.cancel(promptId)}
                onRemove={jobs.remove}
                onRemoveMany={jobs.removeMany}
                onToggleFavorite={jobs.toggleFavorite}
                onClearFinished={jobs.clearFinished}
              />
            </Panel>
          </div>
        </div>
      </main>

      {/* Mobile action bar. The settings panel runs to a dozen-plus controls,
          so an inline Generate button sits well below the fold — pinning it
          keeps the primary action reachable from anywhere on the page. */}
      <div
        className="fixed inset-x-0 bottom-0 z-30 border-t border-border-default
          bg-bg/90 px-4 pt-3 backdrop-blur-md lg:hidden"
        style={{
          // Clear the iOS home indicator without adding dead space elsewhere.
          paddingBottom: "max(0.75rem, env(safe-area-inset-bottom))",
        }}
      >
        <Button
          variant="primary"
          size="lg"
          onClick={submit}
          loading={jobs.submitting}
          disabled={!selected}
          className="w-full"
        >
          {queueLabel}
        </Button>
      </div>

      {tips && selected ? (
        <TipsModal
          open={tipsOpen}
          onClose={() => setTipsOpen(false)}
          title={workflowLabel(selected.name, runModes, selected.patches)}
          tips={tips}
        />
      ) : null}

      {settingsJob ? (
        <SettingsModal
          open
          onClose={() => setSettingsForId(null)}
          job={settingsJob}
          workflow={workflows.find(
            (workflow) => workflow.id === settingsJob.workflowId,
          )}
          // Withheld when the workflow that made this run is no longer
          // registered: there is nothing to load the settings into, and a
          // button that cannot work is worse than no button.
          onReuse={
            workflows.some(
              (workflow) => workflow.id === settingsJob.workflowId,
            )
              ? reuseSettings
              : undefined
          }
        />
      ) : null}
    </div>
  );
}
