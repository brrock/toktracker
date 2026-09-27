import { Dialog } from "@base-ui/react/dialog";
import {
  BookOpen,
  Check,
  ClipboardCopy,
  Loader2,
  Play,
  ShieldCheck,
  Sparkles,
  TriangleAlert,
} from "lucide-react";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";

import { RESULT_DISPLAYS, VALUE_FORMATS } from "@/lib/layout";
import type { ValueFormat } from "@/lib/layout";
import {
  availableTables,
  HELPERS,
  QUERY_LANGUAGES,
  QUERY_LIMITS,
  STARTER_CODE,
} from "@/lib/query/contract";
import type {
  QueryLanguage,
  QueryResponse,
  Tables,
} from "@/lib/query/contract";
import { buildLlmPrompt, MAX_INSTRUCTIONS_LENGTH } from "@/lib/query/prompt";
import type { ResultDisplay } from "@/lib/query/prompt";
import { runQuery } from "@/lib/query/run-query";
import { cn } from "@/lib/utils";

import { SegmentedControl } from "../primitives";
import { QueryResultView } from "./query-result";

// CodeMirror is only downloaded once someone opens the editor.
const CodeEditor = lazy(async () => {
  const module = await import("./code-editor");
  return { default: module.CodeEditor };
});

export interface QueryDraft {
  code: string;
  display: ResultDisplay;
  format: ValueFormat;
  language: QueryLanguage;
  title: string;
}

const COPY_FEEDBACK_MS = 1800;
const STARTERS = new Set<string>(Object.values(STARTER_CODE));

const Reference = ({
  language,
  tables,
}: {
  language: QueryLanguage;
  tables: Tables;
}) => (
  <div className="space-y-5 text-sm">
    <section>
      <h4 className="text-2xs font-semibold uppercase tracking-caps text-muted-foreground">
        Tables
      </h4>
      <p className="mt-1 text-xs text-muted-foreground">
        {language === "sql"
          ? "Each is a table in an in-memory SQLite database."
          : "Each is an array of objects on `data`, e.g. `data.sessions`."}
      </p>
      <div className="mt-3 space-y-3">
        {availableTables(tables).map((table) => (
          <details key={table.name} className="group rounded-lg border bg-card">
            <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 [&::-webkit-details-marker]:hidden">
              <code className="font-mono text-xs font-semibold text-primary">
                {language === "sql" ? table.name : `data.${table.name}`}
              </code>
              <span className="ml-auto text-2xs text-muted-foreground">
                {(tables[table.name] ?? []).length} rows
              </span>
            </summary>
            <div className="border-t px-3 py-2">
              <p className="text-xs text-muted-foreground">
                {table.description}
              </p>
              <ul className="mt-2 space-y-1.5">
                {table.columns.map((column) => (
                  <li key={column.name} className="text-xs">
                    <code className="font-mono font-medium">{column.name}</code>{" "}
                    <span className="text-muted-foreground">
                      {column.type} — {column.description}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          </details>
        ))}
      </div>
    </section>
    {language === "sql" ? (
      <section>
        <h4 className="text-2xs font-semibold uppercase tracking-caps text-muted-foreground">
          SQLite tips
        </h4>
        <ul className="mt-2 space-y-1.5 text-xs text-muted-foreground">
          <li>
            <code className="font-mono text-foreground">
              strftime(&apos;%Y-%W&apos;, date)
            </code>{" "}
            buckets days into weeks.
          </li>
          <li>
            <code className="font-mono text-foreground">
              substr(hour, 12, 2)
            </code>{" "}
            extracts the hour of day.
          </li>
          <li>
            <code className="font-mono text-foreground">
              ROUND(SUM(cost), 2)
            </code>{" "}
            totals spend to the cent.
          </li>
          <li>The last statement that returns rows is shown.</li>
        </ul>
      </section>
    ) : (
      <section>
        <h4 className="text-2xs font-semibold uppercase tracking-caps text-muted-foreground">
          Helpers (`tt`)
        </h4>
        <ul className="mt-3 space-y-3">
          {HELPERS.map((helper) => (
            <li key={helper.name}>
              <code className="block font-mono text-xs font-semibold text-primary">
                tt.{helper.signature}
              </code>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {helper.description}
              </p>
              <code className="mt-1 block font-mono text-2xs text-muted-foreground">
                {helper.example}
              </code>
            </li>
          ))}
        </ul>
      </section>
    )}
    <section className="rounded-lg border border-dashed p-3 text-xs text-muted-foreground">
      <p className="flex items-center gap-1.5 font-medium text-foreground">
        <ShieldCheck className="size-3.5 text-success" />
        Runs in a sandbox
      </p>
      <p className="mt-1">
        Queries run in an isolated worker with no network, storage or page
        access, see only this view&apos;s data, and stop after{" "}
        {QUERY_LIMITS.timeoutMs / 1000}s. Up to {QUERY_LIMITS.rows} rows are
        kept.
      </p>
    </section>
  </div>
);

const AskLlm = ({
  display,
  language,
  tables,
}: {
  display: ResultDisplay;
  language: QueryLanguage;
  tables: Tables;
}) => {
  const [instructions, setInstructions] = useState("");
  const [includeSamples, setIncludeSamples] = useState(false);
  const [copied, setCopied] = useState(false);
  const instructionsId = useId();
  const samplesId = useId();
  const prompt = buildLlmPrompt({
    display,
    includeSamples,
    instructions,
    language,
    tables,
  });
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(prompt);
      setCopied(true);
      window.setTimeout(() => setCopied(false), COPY_FEEDBACK_MS);
    } catch {
      setCopied(false);
    }
  };
  return (
    <div className="space-y-4 text-sm">
      <ol className="space-y-1 text-xs text-muted-foreground">
        <li>1. Describe the table or chart you want.</li>
        <li>2. Copy the prompt into Claude, ChatGPT or any LLM.</li>
        <li>
          3. Paste the reply into the editor — the code is pulled out of it
          automatically — then run it.
        </li>
      </ol>
      <div className="space-y-1.5">
        <label htmlFor={instructionsId} className="text-xs font-medium">
          What should it show?
        </label>
        <textarea
          id={instructionsId}
          maxLength={MAX_INSTRUCTIONS_LENGTH}
          rows={5}
          value={instructions}
          onChange={(event) => setInstructions(event.target.value)}
          placeholder="e.g. Spend per project per week for the last 8 weeks, most expensive first"
          className="w-full resize-y rounded-lg border bg-card px-3 py-2 text-sm outline-none focus:border-primary focus:ring-3 focus:ring-primary/20"
        />
      </div>
      <div className="space-y-1 text-xs">
        <div className="flex items-center gap-2">
          <input
            id={samplesId}
            type="checkbox"
            checked={includeSamples}
            onChange={(event) => setIncludeSamples(event.target.checked)}
            aria-describedby={`${samplesId}-note`}
            className="accent-primary"
          />
          <label htmlFor={samplesId} className="cursor-pointer font-medium">
            Include 3 sample rows per table
          </label>
        </div>
        <p id={`${samplesId}-note`} className="pl-5 text-muted-foreground">
          Helps the LLM, but shares some of your real values (project names,
          session titles) with it. Off by default: only the schema is sent.
        </p>
      </div>
      <button
        type="button"
        onClick={copy}
        className="brand-gradient inline-flex h-9 w-full items-center justify-center gap-2 rounded-lg text-sm font-medium text-primary-foreground"
      >
        {copied ? (
          <Check className="size-4" />
        ) : (
          <ClipboardCopy className="size-4" />
        )}
        {copied ? "Prompt copied" : "Copy LLM prompt"}
      </button>
      <details className="rounded-lg border">
        <summary className="cursor-pointer px-3 py-2 text-xs font-medium">
          Preview prompt ({prompt.length.toLocaleString()} characters)
        </summary>
        <pre className="max-h-72 overflow-auto whitespace-pre-wrap border-t px-3 py-2 font-mono text-2xs text-muted-foreground">
          {prompt}
        </pre>
      </details>
    </div>
  );
};

export const QueryEditorDialog = ({
  initial,
  mode,
  onOpenChange,
  onSave,
  open,
  tables,
}: {
  initial: QueryDraft;
  mode: "create" | "edit";
  onOpenChange: (open: boolean) => void;
  onSave: (draft: QueryDraft) => void;
  open: boolean;
  tables: Tables;
}) => {
  const [draft, setDraft] = useState(initial);
  const [response, setResponse] = useState<QueryResponse>();
  const [running, setRunning] = useState(false);
  const [panel, setPanel] = useState<"reference" | "llm">("reference");
  const controller = useRef<AbortController>(null);
  const titleId = useId();

  const run = useCallback(async (): Promise<void> => {
    controller.current?.abort();
    const current = new AbortController();
    controller.current = current;
    setRunning(true);
    const result = await runQuery(
      { code: draft.code, language: draft.language, tables },
      current.signal
    );
    if (!current.signal.aborted) {
      setResponse(result);
      setRunning(false);
    }
  }, [draft.code, draft.language, tables]);

  useEffect(() => {
    if (open) {
      setDraft(initial);
      setResponse(undefined);
    }
    // Reset only when the dialog opens.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => () => controller.current?.abort(), []);

  const changeLanguage = (language: QueryLanguage): void =>
    setDraft((current) => ({
      ...current,
      code:
        STARTERS.has(current.code) || !current.code.trim()
          ? STARTER_CODE[language]
          : current.code,
      language,
    }));

  const result = response?.ok ? response : undefined;
  const error = response && !response.ok ? response : undefined;

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-50 bg-background/70 backdrop-blur-sm transition-opacity data-[ending-style]:opacity-0 data-[starting-style]:opacity-0" />
        <Dialog.Popup className="fixed top-1/2 left-1/2 z-50 grid h-[min(90vh,56rem)] w-[min(80rem,calc(100vw-2rem))] -translate-1/2 grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden rounded-2xl border bg-popover text-popover-foreground shadow-2xl outline-none transition data-[ending-style]:scale-95 data-[ending-style]:opacity-0 data-[starting-style]:scale-95 data-[starting-style]:opacity-0">
          <div className="flex flex-wrap items-center gap-3 border-b px-5 py-3">
            <div className="min-w-0 flex-1">
              <Dialog.Title className="sr-only">
                {mode === "create" ? "New query widget" : "Edit query widget"}
              </Dialog.Title>
              <Dialog.Description className="sr-only">
                Write SQL, TypeScript or JavaScript against this view&apos;s
                data.
              </Dialog.Description>
              <label htmlFor={titleId} className="sr-only">
                Widget title
              </label>
              <input
                id={titleId}
                value={draft.title}
                maxLength={80}
                placeholder="Untitled query"
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    title: event.target.value,
                  }))
                }
                className="w-full bg-transparent font-heading text-lg font-semibold outline-none placeholder:text-muted-foreground"
              />
            </div>
            <SegmentedControl
              label="Language"
              options={QUERY_LANGUAGES.map((option) => ({
                label: option.label,
                value: option.id,
              }))}
              value={draft.language}
              onChange={changeLanguage}
            />
            <SegmentedControl
              label="Display"
              options={RESULT_DISPLAYS.map((option) => ({
                label: option.label,
                value: option.id,
              }))}
              value={draft.display}
              onChange={(display) =>
                setDraft((current) => ({ ...current, display }))
              }
            />
            <SegmentedControl
              label="Number format"
              options={VALUE_FORMATS.map((option) => ({
                label: option.label,
                value: option.id,
              }))}
              value={draft.format}
              onChange={(format) =>
                setDraft((current) => ({ ...current, format }))
              }
            />
          </div>
          <div className="grid min-h-0 lg:grid-cols-[minmax(0,1fr)_22rem]">
            <div className="grid min-h-0 grid-rows-[minmax(12rem,1fr)_minmax(12rem,20rem)]">
              <div className="min-h-0 border-b">
                <Suspense
                  fallback={
                    <div className="grid h-full place-items-center text-sm text-muted-foreground">
                      Loading editor…
                    </div>
                  }
                >
                  <CodeEditor
                    label={`${draft.language} query`}
                    value={draft.code}
                    language={draft.language}
                    tables={tables}
                    diagnostic={
                      error
                        ? { line: error.line, message: error.error }
                        : undefined
                    }
                    onChange={(code) =>
                      setDraft((current) => ({ ...current, code }))
                    }
                    onRun={run}
                  />
                </Suspense>
              </div>
              <div className="min-h-0 overflow-auto p-4">
                {error && (
                  <div className="flex gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                    <TriangleAlert className="mt-0.5 size-4 shrink-0" />
                    <div className="min-w-0">
                      <p className="font-medium">
                        {error.line ? `Line ${error.line}: ` : ""}
                        {error.error}
                      </p>
                    </div>
                  </div>
                )}
                {result && (
                  <QueryResultView
                    display={draft.display}
                    format={draft.format}
                    result={result}
                  />
                )}
                {!response && (
                  <div className="grid h-full place-items-center text-center text-sm text-muted-foreground">
                    <p>
                      Run the query (
                      <kbd className="rounded border bg-muted px-1 font-mono text-2xs">
                        ⌘/Ctrl
                      </kbd>{" "}
                      +{" "}
                      <kbd className="rounded border bg-muted px-1 font-mono text-2xs">
                        Enter
                      </kbd>
                      ) to preview the result.
                    </p>
                  </div>
                )}
              </div>
            </div>
            <aside className="hidden min-h-0 flex-col border-l lg:flex">
              <div className="flex gap-1 border-b p-2">
                {(
                  [
                    { icon: BookOpen, id: "reference", label: "Reference" },
                    { icon: Sparkles, id: "llm", label: "Ask an LLM" },
                  ] as const
                ).map((tab) => (
                  <button
                    key={tab.id}
                    type="button"
                    aria-pressed={panel === tab.id}
                    onClick={() => setPanel(tab.id)}
                    className={cn(
                      "flex flex-1 items-center justify-center gap-1.5 rounded-md py-1.5 text-xs font-medium transition",
                      panel === tab.id
                        ? "bg-primary/10 text-foreground"
                        : "text-muted-foreground hover:bg-muted"
                    )}
                  >
                    <tab.icon className="size-3.5" />
                    {tab.label}
                  </button>
                ))}
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto p-4">
                {panel === "reference" ? (
                  <Reference language={draft.language} tables={tables} />
                ) : (
                  <AskLlm
                    display={draft.display}
                    language={draft.language}
                    tables={tables}
                  />
                )}
              </div>
            </aside>
          </div>
          <div className="flex flex-wrap items-center gap-3 border-t px-5 py-3">
            <p className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
              {running && "Running in the sandbox…"}
              {!running &&
                result &&
                `${result.rows.length}${result.truncated ? "+" : ""} rows × ${result.columns.length} columns in ${Math.round(result.durationMs)} ms`}
            </p>
            <button
              type="button"
              onClick={run}
              disabled={running}
              className="inline-flex h-9 items-center gap-2 rounded-lg border bg-card px-3 text-sm font-medium transition hover:bg-muted disabled:opacity-60"
            >
              {running ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Play className="size-4" />
              )}
              Run
            </button>
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              className="inline-flex h-9 items-center rounded-lg px-3 text-sm font-medium text-muted-foreground transition hover:bg-muted hover:text-foreground"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => {
                onSave({
                  ...draft,
                  title: draft.title.trim() || "Untitled query",
                });
                onOpenChange(false);
              }}
              className="brand-gradient inline-flex h-9 items-center gap-2 rounded-lg px-4 text-sm font-medium text-primary-foreground"
            >
              <Check className="size-4" />
              {mode === "create" ? "Add widget" : "Save"}
            </button>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
};
