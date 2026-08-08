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
import { ThemeToggle } from "@/components/theme-toggle";
import { TipsModal } from "@/components/tips-modal";
import { tipsFor } from "@/lib/workflows/tips";
import { TokenGate } from "@/components/token-gate";
import { Button } from "@/components/ui/button";
import { Panel, PanelHeader } from "@/components/ui/panel";
import { WorkflowPicker } from "@/components/workflow-picker";
import { GenerationsPanel } from "@/components/generations-panel";
import { useJobs } from "@/hooks/use-jobs";
import { isActive } from "@/lib/jobs";
import { api, ApiError, getToken } from "@/lib/client";
import { hydrateAll, writeStoredParams } from "@/lib/param-storage";
import {
  defaultValuesFor,
  type ParamValue,
  type WorkflowSummary,
} from "@/lib/workflows/types";

interface ConfigPayload {
  authRequired: boolean;
  generationTimeoutSeconds: number;
}

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

  // Values are kept per workflow so switching to compare settings and coming
  // back does not throw away what you typed, and persisted so a reload does
  // not either. Read lazily rather than in an effect: Workbench only mounts
  // after the client-side load, so there is no server render to mismatch, and
  // an effect would flash the defaults first.
  const [valuesByWorkflow, setValuesByWorkflow] = useState<
    Record<string, Record<string, ParamValue>>
  >(() => hydrateAll(workflows));

  useEffect(() => {
    writeStoredParams(valuesByWorkflow);
  }, [valuesByWorkflow]);

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

  const selected = useMemo(
    () => workflows.find((workflow) => workflow.id === selectedId),
    [workflows, selectedId],
  );

  const values = valuesByWorkflow[selectedId] ?? {};

  const setValue = useCallback(
    (id: string, value: ParamValue) => {
      setValuesByWorkflow((previous) => ({
        ...previous,
        [selectedId]: { ...previous[selectedId], [id]: value },
      }));
    },
    [selectedId],
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

  const [tipsOpen, setTipsOpen] = useState(false);
  const tips = selected ? tipsFor(selected.id) : undefined;

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

  const fieldError = useMemo(() => {
    if (!jobs.submitError || !jobs.submitErrorField) return null;
    return { field: jobs.submitErrorField, message: jobs.submitError };
  }, [jobs.submitError, jobs.submitErrorField]);

  const stageRef = useRef<HTMLDivElement>(null);

  const submit = useCallback(() => {
    if (!selected || jobs.submitting) return;
    void jobs.submit(selected, values);
    // On mobile the stage sits below the whole settings panel, so submitting
    // from the pinned bar would otherwise give no visible sign of anything
    // happening. Desktop keeps the stage pinned alongside, so leave it alone.
    if (window.matchMedia("(max-width: 1023px)").matches) {
      requestAnimationFrame(() =>
        stageRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }),
      );
    }
  }, [selected, values, jobs]);

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

  const queueLabel =
    jobs.activeCount > 0 ? `Queue another (${jobs.activeCount} running)` : "Generate video";

  return (
    <div className="min-h-dvh">
      <header
        className="sticky top-0 z-20 border-b border-border-default
          bg-bg/80 backdrop-blur-md"
      >
        <div className="mx-auto flex h-14 max-w-[1400px] items-center gap-2 px-4 sm:gap-3 sm:px-5">
          <span
            aria-hidden="true"
            className="grid size-6 shrink-0 place-items-center rounded bg-fg text-bg"
          >
            <svg viewBox="0 0 16 16" className="size-3" fill="currentColor">
              <path d="M5 3.5v9l7-4.5-7-4.5Z" />
            </svg>
          </span>
          <h1 className="text-[13px] font-medium tracking-[-0.01em] text-fg">
            Soran’t
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

        <div className="grid gap-5 lg:grid-cols-[minmax(320px,380px)_1fr]">
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
                selectedId={selectedId}
                onSelect={setSelectedId}
              />
            </Panel>

            {selected ? (
              <Panel
                className="rise"
                style={{ "--delay": "80ms" } as CSSProperties}
                padded
              >
                <PanelHeader
                  title="Settings"
                  hint={selected.name}
                  action={
                    <div className="flex shrink-0 items-center gap-3">
                      {tips ? (
                        <button
                          type="button"
                          onClick={() => setTipsOpen(true)}
                          className="shrink-0 whitespace-nowrap text-[12px] font-medium
                            text-fg-muted transition-colors hover:text-accent"
                        >
                          Tips
                        </button>
                      ) : null}
                      <button
                        type="button"
                        onClick={resetToDefaults}
                        disabled={isDefaults}
                        title={
                          isDefaults
                            ? "Already at the defaults"
                            : "Put every setting on this workflow back to its default"
                        }
                        className="shrink-0 whitespace-nowrap text-[12px] font-medium
                          text-fg-muted transition-colors hover:text-fg
                          disabled:opacity-40 disabled:hover:text-fg-muted"
                      >
                        Restore defaults
                      </button>
                    </div>
                  }
                />
                {/* Deliberately never disabled: a running generation should not
                    stop you setting up the next one. */}
                <ParamForm
                  params={selected.params}
                  values={values}
                  onChange={setValue}
                  fieldError={fieldError}
                />
              </Panel>
            ) : null}
          </div>

          <div
            ref={stageRef}
            className="flex scroll-mt-20 flex-col gap-4 lg:sticky lg:top-20 lg:self-start"
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
                <button
                  type="button"
                  onClick={jobs.dismissSubmitError}
                  aria-label="Dismiss"
                  className="shrink-0 font-medium hover:underline"
                >
                  Dismiss
                </button>
              </div>
            ) : null}

            <GenerationStage
              job={viewedJob}
              now={now}
              onCancel={(promptId) => void jobs.cancel(promptId)}
              onReuseSeed={(seed) => setValue("seed", seed)}
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
          title={selected.name}
          tips={tips}
        />
      ) : null}
    </div>
  );
}
