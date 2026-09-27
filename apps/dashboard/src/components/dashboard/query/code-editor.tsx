import { autocompletion } from "@codemirror/autocomplete";
import type {
  Completion,
  CompletionContext,
  CompletionResult,
} from "@codemirror/autocomplete";
import { indentWithTab } from "@codemirror/commands";
import { javascript } from "@codemirror/lang-javascript";
import { SQLite, sql } from "@codemirror/lang-sql";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { lintGutter, setDiagnostics } from "@codemirror/lint";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView, hoverTooltip, keymap } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { basicSetup } from "codemirror";
import { useEffect, useRef } from "react";

import {
  availableTables,
  HELPERS,
  JS_GLOBALS,
  TABLES,
} from "@/lib/query/contract";
import type { QueryLanguage, Tables } from "@/lib/query/contract";

const FENCED_CODE = /```[\w-]*\n(?<code>[\s\S]*?)```/u;
const MEMBER_BEFORE = /[\w$]+\.[\w$]*$/u;
const STRING_BEFORE = /["'`][\w]*$/u;
const WORD = /[\w$]/u;

/** Pasting an LLM reply keeps only the code inside its fenced block. */
export const extractCode = (text: string): string => {
  const code = FENCED_CODE.exec(text)?.groups?.code;
  return code ? code.trimEnd() : text;
};

const docNode = (
  title: string,
  body: string,
  example?: string
): HTMLElement => {
  // Built with textContent only: documentation never goes through HTML.
  const root = document.createElement("div");
  root.className = "cm-doc";
  const heading = document.createElement("code");
  heading.className = "cm-doc-title";
  heading.textContent = title;
  const text = document.createElement("p");
  text.textContent = body;
  root.append(heading, text);
  if (example) {
    const sample = document.createElement("code");
    sample.className = "cm-doc-example";
    sample.textContent = example;
    root.append(sample);
  }
  return root;
};

const columnCompletions = (tables: Tables): Completion[] => {
  const seen = new Map<string, Completion>();
  for (const table of availableTables(tables)) {
    for (const column of table.columns) {
      if (!seen.has(column.name)) {
        seen.set(column.name, {
          detail: column.type,
          info: () =>
            docNode(`${table.name}.${column.name}`, column.description),
          label: column.name,
          type: "property",
        });
      }
    }
  }
  return [...seen.values()];
};

const scriptCompletions =
  (tables: Tables) =>
  (context: CompletionContext): CompletionResult | null => {
    const member = context.matchBefore(MEMBER_BEFORE);
    if (member) {
      const [owner = ""] = member.text.split(".");
      const from = member.from + owner.length + 1;
      if (owner === "data") {
        return {
          from,
          options: availableTables(tables).map((table) => ({
            detail: `${(tables[table.name] ?? []).length} rows`,
            info: () =>
              docNode(
                `data.${table.name}`,
                `${table.description} Columns: ${table.columns.map((column) => column.name).join(", ")}.`
              ),
            label: table.name,
            type: "variable",
          })),
          validFor: /^[\w$]*$/u,
        };
      }
      if (owner === "tt") {
        return {
          from,
          options: HELPERS.map((helper) => ({
            apply: `${helper.name}(`,
            detail: helper.signature.slice(helper.name.length),
            info: () =>
              docNode(
                `tt.${helper.signature}`,
                helper.description,
                helper.example
              ),
            label: helper.name,
            type: "function",
          })),
          validFor: /^[\w$]*$/u,
        };
      }
      return {
        from,
        options: columnCompletions(tables),
        validFor: /^[\w$]*$/u,
      };
    }
    const quoted = context.matchBefore(STRING_BEFORE);
    if (quoted) {
      return {
        from: quoted.from + 1,
        options: columnCompletions(tables),
        validFor: /^[\w]*$/u,
      };
    }
    const word = context.matchBefore(/[\w$]+$/u);
    if (!word && !context.explicit) {
      return null;
    }
    return {
      from: word?.from ?? context.pos,
      options: JS_GLOBALS.map((global) => ({
        info: () => docNode(global.name, global.description),
        label: global.name,
        type: "variable",
      })),
      validFor: /^[\w$]*$/u,
    };
  };

// lang-sql only suggests columns once a FROM clause names their table;
// offer every column (ranked above keywords) from the first letter.
const sqlColumnCompletions =
  (tables: Tables) =>
  (context: CompletionContext): CompletionResult | null => {
    const word = context.matchBefore(/[\w]+$/u);
    if (!word || (word.from === word.to && !context.explicit)) {
      return null;
    }
    return {
      from: word.from,
      options: columnCompletions(tables).map((option) => ({
        ...option,
        boost: 2,
      })),
      validFor: /^[\w]*$/u,
    };
  };

const sqlSupport = (tables: Tables) => {
  const available = availableTables(tables);
  const support = sql({
    dialect: SQLite,
    schema: Object.fromEntries(
      available.map((table) => [
        table.name,
        table.columns.map((column) => ({
          detail: column.type,
          info: () =>
            docNode(`${table.name}.${column.name}`, column.description),
          label: column.name,
          type: "property",
        })),
      ])
    ),
    tables: available.map((table) => ({
      detail: `${(tables[table.name] ?? []).length} rows`,
      info: () => docNode(table.name, table.description),
      label: table.name,
      type: "type",
    })),
    upperCaseKeywords: true,
  });
  return [
    support,
    support.language.data.of({ autocomplete: sqlColumnCompletions(tables) }),
  ];
};

const wordAt = (
  view: EditorView,
  pos: number
): { from: number; text: string; to: number } | null => {
  const line = view.state.doc.lineAt(pos);
  let start = pos - line.from;
  let end = start;
  while (start > 0 && WORD.test(line.text.charAt(start - 1))) {
    start -= 1;
  }
  while (end < line.text.length && WORD.test(line.text.charAt(end))) {
    end += 1;
  }
  if (start === end) {
    return null;
  }
  return {
    from: line.from + start,
    text: line.text.slice(start, end),
    to: line.from + end,
  };
};

const hoverDocs = hoverTooltip((view, pos) => {
  const word = wordAt(view, pos);
  if (!word) {
    return null;
  }
  const helper = HELPERS.find((item) => item.name === word.text);
  const isHelperCall =
    helper &&
    view.state.sliceDoc(Math.max(0, word.from - 3), word.from) === "tt.";
  const table = TABLES.find((item) => item.name === word.text);
  const column = TABLES.flatMap((item) =>
    item.columns.map((entry) => ({ ...entry, table: item.name }))
  ).find((item) => item.name === word.text);
  const global = JS_GLOBALS.find((item) => item.name === word.text);
  let node: HTMLElement | undefined;
  if (helper && isHelperCall) {
    node = docNode(
      `tt.${helper.signature}`,
      helper.description,
      helper.example
    );
  } else if (table) {
    node = docNode(
      table.name,
      `${table.description} Columns: ${table.columns.map((item) => item.name).join(", ")}.`
    );
  } else if (global) {
    node = docNode(global.name, global.description);
  } else if (column) {
    node = docNode(
      `${column.table}.${column.name} (${column.type})`,
      column.description
    );
  }
  if (!node) {
    return null;
  }
  const dom = node;
  return { above: true, create: () => ({ dom }), end: word.to, pos: word.from };
});

const highlight = HighlightStyle.define([
  { color: "var(--chart-4)", fontWeight: "600", tag: tags.keyword },
  { color: "var(--chart-2)", tag: [tags.string, tags.special(tags.string)] },
  { color: "var(--chart-5)", tag: [tags.number, tags.bool, tags.null] },
  {
    color: "var(--primary)",
    tag: [tags.function(tags.variableName), tags.function(tags.propertyName)],
  },
  { color: "var(--chart-3)", tag: [tags.typeName, tags.className] },
  { color: "var(--foreground)", tag: [tags.propertyName, tags.variableName] },
  { color: "var(--muted-foreground)", fontStyle: "italic", tag: tags.comment },
  { color: "var(--muted-foreground)", tag: [tags.operator, tags.punctuation] },
]);

const theme = EditorView.theme({
  "&": {
    backgroundColor: "var(--card)",
    color: "var(--foreground)",
    fontSize: "13px",
    height: "100%",
  },
  "&.cm-focused": { outline: "none" },
  ".cm-activeLine": {
    backgroundColor: "color-mix(in oklch, var(--muted) 55%, transparent)",
  },
  ".cm-activeLineGutter": { backgroundColor: "var(--muted)" },
  ".cm-content": {
    caretColor: "var(--primary)",
    fontFamily: "var(--font-mono)",
    padding: "12px 0",
  },
  ".cm-cursor": { borderLeftColor: "var(--primary)" },
  ".cm-doc": { maxWidth: "26rem", padding: "8px 10px" },
  ".cm-doc p": { margin: "4px 0 0" },
  ".cm-doc-example": {
    color: "var(--muted-foreground)",
    display: "block",
    fontSize: "11px",
    marginTop: "6px",
  },
  ".cm-doc-title": { color: "var(--primary)", fontSize: "12px" },
  ".cm-gutters": {
    backgroundColor: "var(--card)",
    borderRight: "1px solid var(--border)",
    color: "var(--muted-foreground)",
  },
  ".cm-scroller": { fontFamily: "var(--font-mono)", overflow: "auto" },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
    backgroundColor:
      "color-mix(in oklch, var(--primary) 25%, transparent) !important",
  },
  ".cm-tooltip": {
    backgroundColor: "var(--popover)",
    border: "1px solid var(--border)",
    borderRadius: "var(--radius-md)",
    boxShadow: "var(--elevation)",
    color: "var(--popover-foreground)",
  },
  ".cm-tooltip-autocomplete ul li[aria-selected]": {
    backgroundColor: "color-mix(in oklch, var(--primary) 18%, transparent)",
    color: "var(--foreground)",
  },
});

const languageExtension = (language: QueryLanguage, tables: Tables) => {
  if (language === "sql") {
    return sqlSupport(tables);
  }
  const support = javascript({ typescript: language === "typescript" });
  return [
    support,
    support.language.data.of({ autocomplete: scriptCompletions(tables) }),
  ];
};

export interface EditorDiagnostic {
  line?: number;
  message: string;
}

export const CodeEditor = ({
  diagnostic,
  label,
  language,
  onChange,
  onRun,
  tables,
  value,
}: {
  diagnostic?: EditorDiagnostic;
  label: string;
  language: QueryLanguage;
  onChange: (value: string) => void;
  onRun: () => void;
  tables: Tables;
  value: string;
}) => {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView>(null);
  const languageSlot = useRef(new Compartment());
  const handlers = useRef({ onChange, onRun });
  handlers.current = { onChange, onRun };

  useEffect(() => {
    if (!host.current) {
      return;
    }
    const editor = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          basicSetup,
          keymap.of([
            {
              key: "Mod-Enter",
              preventDefault: true,
              run: () => {
                handlers.current.onRun();
                return true;
              },
            },
            indentWithTab,
          ]),
          languageSlot.current.of(languageExtension(language, tables)),
          autocompletion({ activateOnTyping: true, icons: true }),
          hoverDocs,
          lintGutter(),
          syntaxHighlighting(highlight),
          theme,
          EditorView.contentAttributes.of({ "aria-label": label }),
          EditorView.domEventHandlers({
            paste: (event, target) => {
              const text = event.clipboardData?.getData("text/plain") ?? "";
              const code = extractCode(text);
              if (code === text) {
                return false;
              }
              event.preventDefault();
              target.dispatch(target.state.replaceSelection(code));
              return true;
            },
          }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) {
              handlers.current.onChange(update.state.doc.toString());
            }
          }),
        ],
      }),
    });
    view.current = editor;
    return () => {
      editor.destroy();
      view.current = null;
    };
    // The editor is created once; later prop changes are applied below.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    view.current?.dispatch({
      effects: languageSlot.current.reconfigure(
        languageExtension(language, tables)
      ),
    });
  }, [language, tables]);

  useEffect(() => {
    const editor = view.current;
    if (editor && editor.state.doc.toString() !== value) {
      editor.dispatch({
        changes: { from: 0, insert: value, to: editor.state.doc.length },
      });
    }
  }, [value]);

  useEffect(() => {
    const editor = view.current;
    if (!editor) {
      return;
    }
    const { lines } = editor.state.doc;
    const line =
      diagnostic?.line && diagnostic.line <= lines
        ? editor.state.doc.line(diagnostic.line)
        : undefined;
    editor.dispatch(
      setDiagnostics(
        editor.state,
        diagnostic
          ? [
              {
                from: line?.from ?? 0,
                message: diagnostic.message,
                severity: "error",
                to: line?.to ?? Math.min(editor.state.doc.length, 1),
              },
            ]
          : []
      )
    );
  }, [diagnostic]);

  return (
    // Escape belongs to the editor (closing completions and tooltips); it
    // must not also close the dialog and discard unsaved code.
    // oxlint-disable-next-line jsx-a11y/no-static-element-interactions -- keyboard events bubble from CodeMirror's own focusable content
    <div
      ref={host}
      className="h-full min-h-0 overflow-hidden"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
        }
      }}
    />
  );
};
