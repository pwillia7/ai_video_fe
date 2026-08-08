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
import { GenerationStage } from "@/components/generation-stage";
import { ParamForm } from "@/components/param-form";
import { ThemeToggle } from "@/components/theme-toggle";
import { TokenGate } from "@/components/token-gate";
import { Button } from "@/components/ui/button";
import { Panel, PanelHeader } from "@/components/ui/panel";
import { WorkflowPicker } from "@/components/workflow-picker";
import { useGeneration } from "@/hooks/use-generation";
import { api, ApiError, getToken } from "@/lib/client";
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
    <Workbench
      workflows={boot.workflows}
      timeoutSeconds={boot.timeoutSeconds}
      problems={boot.problems}
    />
  );
}

function Workbench({
  workflows,
  timeoutSeconds,
  problems,
}: {
  workflows: WorkflowSummary[];
  timeoutSeconds: number;
  problems?: string[];
}) {
  const [selectedId, setSelectedId] = useState(workflows[0]?.id ?? "");

  // Values are kept per workflow so switching to compare settings and coming
  // back does not throw away what you typed.
  const [valuesByWorkflow, setValuesByWorkflow] = useState<
    Record<string, Record<string, ParamValue>>
  >(() =>
    Object.fromEntries(
      workflows.map((workflow) => [workflow.id, defaultValuesFor(workflow)]),
    ),
  );

  const generation = useGeneration(timeoutSeconds);

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
    setValuesByWorkflow((previous) => ({
      ...previous,
      [selectedId]: defaultValuesFor(selected),
    }));
  }, [selected, selectedId]);

  // Only surface an inline field error when the server actually blamed a field;
  // anything else belongs in the stage panel, not under a control.
  const fieldError = useMemo(() => {
    if (generation.phase !== "error" || !generation.error) return null;
    if (!generation.errorField) return null;
    return { field: generation.errorField, message: generation.error };
  }, [generation.phase, generation.error, generation.errorField]);

  const submit = useCallback(() => {
    if (!selected || generation.isBusy) return;
    void generation.start(selected.id, values);
  }, [selected, generation.isBusy, generation.start, values]);

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

  return (
    <div className="min-h-dvh">
      <header
        className="sticky top-0 z-20 border-b border-border-default
          bg-bg/80 backdrop-blur-md"
      >
        <div className="mx-auto flex h-14 max-w-[1400px] items-center gap-3 px-5">
          <span
            aria-hidden="true"
            className="grid size-6 place-items-center rounded bg-fg text-bg"
          >
            <svg viewBox="0 0 16 16" className="size-3" fill="currentColor">
              <path d="M5 3.5v9l7-4.5-7-4.5Z" />
            </svg>
          </span>
          <h1 className="text-[13px] font-medium tracking-[-0.01em] text-fg">
            Video Studio
          </h1>
          <span className="text-[13px] text-fg-subtle">/ ComfyUI</span>

          <div className="ml-auto flex items-center gap-2">
            <ConnectionPill />
            <ThemeToggle />
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-[1400px] px-5 py-6">
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
          <div className="flex flex-col gap-5">
            <Panel className="rise" padded>
              <PanelHeader
                title="Workflow"
                hint="Preconfigured graphs on the ComfyUI instance."
              />
              <WorkflowPicker
                workflows={workflows}
                selectedId={selectedId}
                onSelect={setSelectedId}
                disabled={generation.isBusy}
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
                    <button
                      type="button"
                      onClick={resetToDefaults}
                      disabled={generation.isBusy}
                      className="text-[12px] font-medium text-fg-muted transition-colors
                        hover:text-fg disabled:opacity-50"
                    >
                      Reset
                    </button>
                  }
                />
                <ParamForm
                  params={selected.params}
                  values={values}
                  onChange={setValue}
                  disabled={generation.isBusy}
                  fieldError={fieldError}
                />
              </Panel>
            ) : null}
          </div>

          <div className="flex flex-col gap-4 lg:sticky lg:top-20 lg:self-start">
            <div className="flex items-center gap-3">
              <Button
                variant="primary"
                size="lg"
                onClick={submit}
                loading={generation.isBusy}
                disabled={!selected}
                className="flex-1 sm:flex-none sm:min-w-44"
              >
                {generation.isBusy ? "Generating…" : "Generate video"}
              </Button>
              <span className="hidden text-[12px] text-fg-subtle sm:block">
                or press{" "}
                <kbd
                  className="rounded border border-border-default bg-bg-subtle
                    px-1.5 py-0.5 font-mono text-[11px]"
                >
                  ⌘↵
                </kbd>
              </span>
            </div>

            <GenerationStage
              generation={generation}
              onReuseSeed={(seed) => setValue("seed", seed)}
              hasAudio={selected?.hasAudio}
            />
          </div>
        </div>
      </main>
    </div>
  );
}
