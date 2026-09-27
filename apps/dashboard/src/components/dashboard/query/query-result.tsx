import { useState } from "react";

import type { ValueFormat } from "@/lib/layout";
import { isNumberCell, isTextCell } from "@/lib/query/contract";
import type { Cell, QueryResult } from "@/lib/query/contract";
import type { ResultDisplay } from "@/lib/query/prompt";
import { cn } from "@/lib/utils";

import { SERIES_COLORS } from "../charts";

const TABLE_PREVIEW_ROWS = 200;
const CHART_POINTS = 60;
const DONUT_SLICES = 8;
const DONUT_RADIUS = 15.9155;
const GRID_LINES = 4;
const COMPACT_THRESHOLD = 10_000;
const CURRENCY_COLUMN = /cost|spend|usd|price/iu;
// "tokensPerDollar" or "cost_per_token" are rates, not amounts of money.
const RATE_COLUMN = /per/iu;

const compactFormat = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 1,
  notation: "compact",
});
const numberFormat = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 2,
});
const currencyFormat = new Intl.NumberFormat("en-US", {
  currency: "USD",
  maximumFractionDigits: 2,
  style: "currency",
});
const percentFormat = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 1,
  style: "percent",
});

const compactCurrencyFormat = new Intl.NumberFormat("en-US", {
  currency: "USD",
  maximumFractionDigits: 1,
  notation: "compact",
  style: "currency",
});

export const formatCell = (
  value: Cell,
  format: ValueFormat,
  column = ""
): string => {
  if (value === null) {
    return "—";
  }
  if (!isNumberCell(value)) {
    return String(value);
  }
  switch (format) {
    case "compact": {
      return compactFormat.format(value);
    }
    case "currency": {
      return currencyFormat.format(value);
    }
    case "percent": {
      return percentFormat.format(value);
    }
    case "number": {
      return numberFormat.format(value);
    }
    default: {
      if (CURRENCY_COLUMN.test(column) && !RATE_COLUMN.test(column)) {
        return currencyFormat.format(value);
      }
      return Math.abs(value) >= COMPACT_THRESHOLD
        ? compactFormat.format(value)
        : numberFormat.format(value);
    }
  }
};

/** Short tick labels for chart axes. */
const formatAxis = (
  value: number,
  format: ValueFormat,
  column: string
): string => {
  const full = formatCell(value, format, column);
  if (full.startsWith("$")) {
    return Math.abs(value) >= 1000 ? compactCurrencyFormat.format(value) : full;
  }
  return format === "percent" ? full : compactFormat.format(value);
};

/** Picks the label and value columns a chart plots. */
export const chartColumns = (
  result: Pick<QueryResult, "columns" | "rows">
): { label: number; value: number } | undefined => {
  const isKind = (index: number, kind: "text" | "number"): boolean =>
    result.rows.some((row) =>
      kind === "number" ? isNumberCell(row[index]) : isTextCell(row[index])
    );
  const indexes = result.columns.map((_, index) => index);
  const value = indexes.find((index) => isKind(index, "number"));
  if (value === undefined) {
    return undefined;
  }
  const label =
    indexes.find((index) => index !== value && isKind(index, "text")) ??
    indexes.find((index) => index !== value) ??
    -1;
  return { label, value };
};

const ResultTable = ({
  format,
  result,
}: {
  format: ValueFormat;
  result: QueryResult;
}) => {
  const shown = result.rows.slice(0, TABLE_PREVIEW_ROWS);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-auto rounded-lg border">
        <table className="w-full text-left text-sm">
          <thead className="sticky top-0 bg-muted text-2xs uppercase tracking-wider text-muted-foreground">
            <tr>
              {result.columns.map((column) => (
                <th
                  key={column}
                  className="whitespace-nowrap px-3 py-2 font-medium"
                >
                  {column}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((row, rowIndex) => (
              // oxlint-disable-next-line react/no-array-index-key -- result rows have no identity
              <tr key={rowIndex} className="border-t hover:bg-muted/40">
                {row.map((cell, cellIndex) => (
                  <td
                    // oxlint-disable-next-line react/no-array-index-key -- cells are positional
                    key={cellIndex}
                    className={cn(
                      "max-w-72 truncate px-3 py-1.5",
                      isNumberCell(cell) && "text-right tabular-nums"
                    )}
                    title={isTextCell(cell) ? cell : undefined}
                  >
                    {formatCell(cell, format, result.columns[cellIndex])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {!result.rows.length && (
          <p className="p-6 text-center text-sm text-muted-foreground">
            The query returned no rows.
          </p>
        )}
      </div>
      {(result.rows.length > shown.length || result.truncated) && (
        <p className="mt-2 text-2xs text-muted-foreground">
          Showing {shown.length} of {result.rows.length}
          {result.truncated ? "+" : ""} rows.
        </p>
      )}
    </div>
  );
};

interface Point {
  label: string;
  value: number;
}

const points = (result: QueryResult, limit: number): Point[] | undefined => {
  const columns = chartColumns(result);
  if (!columns) {
    return undefined;
  }
  return result.rows.slice(0, limit).map((row, index) => ({
    label:
      columns.label === -1
        ? String(index + 1)
        : String(row[columns.label] ?? ""),
    value: isNumberCell(row[columns.value]) ? Number(row[columns.value]) : 0,
  }));
};

const SeriesChart = ({
  column,
  data,
  display,
  format,
}: {
  column: string;
  data: Point[];
  display: "bar" | "line" | "area";
  format: ValueFormat;
}) => {
  const [hovered, setHovered] = useState<number>();
  const maximum = Math.max(...data.map((point) => point.value), 0) || 1;
  const labelEvery = Math.max(1, Math.ceil(data.length / 6));
  const step = data.length > 1 ? 100 / (data.length - 1) : 0;
  const coordinates = data.map((point, index) => ({
    x: data.length > 1 ? index * step : 50,
    y: 100 - (Math.max(0, point.value) / maximum) * 96,
  }));
  const path = coordinates
    .map((point, index) => `${index ? "L" : "M"}${point.x},${point.y}`)
    .join(" ");
  const active = hovered === undefined ? undefined : data[hovered];
  return (
    <div className="flex h-full min-h-48 flex-col">
      <div className="mb-3 flex items-baseline gap-2">
        <span className="font-heading text-2xl font-semibold tabular-nums">
          {active ? formatCell(active.value, format, column) : column}
        </span>
        {active && (
          <span className="truncate text-sm text-muted-foreground">
            {active.label}
          </span>
        )}
      </div>
      <div className="relative min-h-0 flex-1 pl-12">
        <div className="pointer-events-none absolute top-0 right-0 bottom-6 left-0 flex flex-col justify-between">
          {Array.from({ length: GRID_LINES + 1 }, (_, line) => (
            <div
              key={line}
              className="flex items-center gap-2 text-3xs text-muted-foreground"
            >
              <span className="w-10 shrink-0 truncate text-right tabular-nums">
                {formatAxis(
                  (maximum * (GRID_LINES - line)) / GRID_LINES,
                  format,
                  column
                )}
              </span>
              <span
                className={cn(
                  "h-px flex-1",
                  line === GRID_LINES ? "bg-border" : "border-t border-dashed"
                )}
              />
            </div>
          ))}
        </div>
        {display !== "bar" && (
          <div className="pointer-events-none absolute top-0 right-0 bottom-6 left-12">
            <svg
              aria-hidden="true"
              viewBox="0 0 100 100"
              preserveAspectRatio="none"
              className="size-full overflow-visible"
            >
              {display === "area" && (
                <path
                  d={`${path} L100,100 L0,100 Z`}
                  className="fill-primary/20"
                />
              )}
              <path
                d={path}
                fill="none"
                className="stroke-primary"
                strokeWidth="2.25"
                strokeLinejoin="round"
                strokeLinecap="round"
                vectorEffect="non-scaling-stroke"
              />
            </svg>
          </div>
        )}
        <div
          className="relative flex h-full items-end gap-0.75"
          onMouseLeave={() => setHovered(undefined)}
        >
          {data.map((point, index) => (
            <button
              // oxlint-disable-next-line react/no-array-index-key -- labels may repeat
              key={index}
              type="button"
              aria-label={`${point.label}: ${formatCell(point.value, format, column)}`}
              onMouseEnter={() => setHovered(index)}
              onFocus={() => setHovered(index)}
              className="flex h-full min-w-0 flex-1 cursor-default flex-col justify-end focus:outline-none"
            >
              <span className="relative flex min-h-0 w-full flex-1 items-end">
                {display === "bar" ? (
                  <span
                    className={cn(
                      "animate-grow-up stagger bar-fill h-(--bar-size) w-full rounded-t-sm transition-opacity",
                      hovered !== undefined && hovered !== index && "opacity-40"
                    )}
                    style={{
                      "--bar-size": `${Math.max(1, (Math.max(0, point.value) / maximum) * 100)}%`,
                      "--stagger-index": index,
                    }}
                  />
                ) : (
                  <span
                    className={cn(
                      "mx-auto h-full w-px",
                      hovered === index && "bg-primary/30"
                    )}
                  />
                )}
              </span>
              <span className="mt-2 h-4 w-full truncate text-center text-3xs text-muted-foreground">
                {index % labelEvery === 0 || index === data.length - 1
                  ? point.label
                  : ""}
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
};

const DonutChart = ({
  column,
  data,
  format,
}: {
  column: string;
  data: Point[];
  format: ValueFormat;
}) => {
  const positive = data.filter((point) => point.value > 0);
  const total = positive.reduce((sum, point) => sum + point.value, 0) || 1;
  const shares = positive.map((point) => (point.value / total) * 100);
  const offsets = shares.map((_, index) =>
    shares.slice(0, index).reduce((sum, share) => sum + share, 0)
  );
  return (
    <div className="flex flex-wrap items-center gap-6">
      <div className="relative size-40 shrink-0">
        <svg
          aria-hidden="true"
          viewBox="0 0 42 42"
          className="animate-rise size-full -rotate-90"
        >
          <circle
            cx="21"
            cy="21"
            r={DONUT_RADIUS}
            fill="none"
            className="stroke-muted"
            strokeWidth="6"
          />
          {positive.map((_, index) => {
            const share = shares[index] ?? 0;
            return (
              <circle
                // oxlint-disable-next-line react/no-array-index-key -- labels may repeat
                key={index}
                cx="21"
                cy="21"
                r={DONUT_RADIUS}
                fill="none"
                className="stroke-(--series)"
                style={{
                  "--series": SERIES_COLORS[index % SERIES_COLORS.length],
                }}
                strokeDasharray={`${Math.max(0, share - 0.6)} ${100 - Math.max(0, share - 0.6)}`}
                strokeDashoffset={-(offsets[index] ?? 0)}
                strokeWidth="6"
              />
            );
          })}
        </svg>
        <div className="absolute inset-0 grid place-items-center text-center">
          <div>
            <div className="font-heading text-lg font-semibold tabular-nums">
              {formatCell(total, format, column)}
            </div>
            <div className="text-3xs uppercase tracking-wider text-muted-foreground">
              {column}
            </div>
          </div>
        </div>
      </div>
      <ul className="min-w-40 flex-1 space-y-1.5 text-sm">
        {positive.map((point, index) => (
          // oxlint-disable-next-line react/no-array-index-key -- labels may repeat
          <li key={index} className="flex items-center gap-2">
            <span
              className="size-2.5 shrink-0 rounded-full bg-(--series)"
              style={{
                "--series": SERIES_COLORS[index % SERIES_COLORS.length],
              }}
            />
            <span className="min-w-0 flex-1 truncate">{point.label}</span>
            <span className="text-xs tabular-nums text-muted-foreground">
              {Math.round((point.value / total) * 100)}%
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
};

export const QueryResultView = ({
  display,
  format,
  result,
}: {
  display: ResultDisplay;
  format: ValueFormat;
  result: QueryResult;
}) => {
  const columns = chartColumns(result);
  const column = columns ? (result.columns[columns.value] ?? "") : "";
  if (display === "table" || !columns) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        {display !== "table" && (
          <p className="mb-2 text-xs text-muted-foreground">
            Charts need a numeric column; showing the result as a table.
          </p>
        )}
        <ResultTable format={format} result={result} />
      </div>
    );
  }
  if (display === "stat") {
    const value = result.rows[0]?.[columns.value] ?? null;
    return (
      <div className="flex h-full flex-col justify-center">
        <div className="font-heading text-5xl font-semibold tabular-nums tracking-tight">
          {formatCell(value, format, column)}
        </div>
        <div className="mt-2 text-sm text-muted-foreground">{column}</div>
      </div>
    );
  }
  if (display === "donut") {
    return (
      <DonutChart
        column={column}
        data={points(result, DONUT_SLICES) ?? []}
        format={format}
      />
    );
  }
  return (
    <SeriesChart
      column={column}
      data={points(result, CHART_POINTS) ?? []}
      display={display}
      format={format}
    />
  );
};
