import { Code2, Loader2, TriangleAlert } from "lucide-react";
import { useEffect, useState } from "react";

import type { Widget } from "@/lib/layout";
import { QUERY_LANGUAGES } from "@/lib/query/contract";
import type { QueryResponse, Tables } from "@/lib/query/contract";
import { runQuery } from "@/lib/query/run-query";

import { Card, CardHeader } from "../primitives";
import { QueryEditorDialog } from "./query-editor";
import type { QueryDraft } from "./query-editor";
import { QueryResultView } from "./query-result";

type QueryWidgetConfig = Extract<Widget, { kind: "query" }>;

export const QueryWidget = ({
  onChange,
  tables,
  widget,
}: {
  onChange: (changes: Partial<QueryDraft>) => void;
  tables: Tables;
  widget: QueryWidgetConfig;
}) => {
  const [response, setResponse] = useState<QueryResponse>();
  const [editorOpen, setEditorOpen] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    const load = async (): Promise<void> => {
      const result = await runQuery(
        { code: widget.code, language: widget.language, tables },
        controller.signal
      );
      if (!controller.signal.aborted) {
        setResponse(result);
      }
    };
    load();
    return () => controller.abort();
  }, [tables, widget.code, widget.language]);

  const languageLabel =
    QUERY_LANGUAGES.find((option) => option.id === widget.language)?.label ??
    widget.language;

  return (
    <Card className="flex h-full min-h-72 flex-col">
      <CardHeader
        title={widget.title ?? "Query"}
        description={
          response?.ok
            ? `${languageLabel} · ${response.rows.length}${response.truncated ? "+" : ""} rows`
            : languageLabel
        }
        action={
          <button
            type="button"
            onClick={() => setEditorOpen(true)}
            className="inline-flex h-7 items-center gap-1.5 rounded-lg border bg-card px-2.5 text-xs font-medium text-muted-foreground transition hover:text-foreground"
          >
            <Code2 className="size-3.5" />
            Edit query
          </button>
        }
      />
      <div className="mt-4 min-h-0 flex-1">
        {!response && (
          <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            Running…
          </div>
        )}
        {response && !response.ok && (
          <div className="flex gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            <TriangleAlert className="mt-0.5 size-4 shrink-0" />
            <p className="min-w-0 break-words">
              {response.line ? `Line ${response.line}: ` : ""}
              {response.error}
            </p>
          </div>
        )}
        {response?.ok && (
          <QueryResultView
            display={widget.display}
            format={widget.format}
            result={response}
          />
        )}
      </div>
      <QueryEditorDialog
        mode="edit"
        open={editorOpen}
        onOpenChange={setEditorOpen}
        tables={tables}
        initial={{
          code: widget.code,
          display: widget.display,
          format: widget.format,
          language: widget.language,
          title: widget.title ?? "",
        }}
        onSave={onChange}
      />
    </Card>
  );
};
