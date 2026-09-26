import { CircleDollarSign, Zap } from "lucide-react";

import { useAppearance } from "@/components/theme-provider";
import { greeting } from "@/lib/appearance";

import { SERIES_COLORS } from "./charts";
import { BrandMark, Sparkline } from "./primitives";

const PREVIEW_BARS = [34, 52, 41, 68, 57, 80, 63, 92, 71, 86, 60, 98];
const PREVIEW_SHARES = [
  { name: "Claude", share: 46 },
  { name: "Codex", share: 27 },
  { name: "Cursor", share: 17 },
  { name: "OpenCode", share: 10 },
];

// A miniature dashboard that renders with the live theme tokens, so every
// appearance change can be judged before leaving the picker.
export const AppearancePreview = () => {
  const { appearance } = useAppearance();
  return (
    <div
      aria-hidden="true"
      className="relative overflow-hidden rounded-2xl border bg-background shadow-2xl"
    >
      <div className="app-backdrop" style={{ position: "absolute" }} />
      <div className="relative flex">
        <div className="hidden w-32 shrink-0 border-r bg-sidebar/80 p-3 sm:block">
          <div className="flex items-center gap-2">
            <BrandMark className="size-6" />
            <span className="font-heading text-xs font-semibold">
              TokTracker
            </span>
          </div>
          <div className="mt-5 space-y-1">
            {["Overview", "Agents", "Projects", "Sessions"].map(
              (item, index) => (
                <div
                  key={item}
                  className={`rounded-md px-2 py-1 text-[10px] ${index === 0 ? "bg-primary/10 font-medium text-foreground" : "text-muted-foreground"}`}
                >
                  {item}
                </div>
              )
            )}
          </div>
        </div>
        <div className="min-w-0 flex-1 space-y-3 p-4">
          <div>
            <p className="text-[9px] font-medium uppercase tracking-[0.14em] text-primary">
              Preview
            </p>
            <p className="text-gradient font-heading text-lg font-semibold">
              {greeting(new Date(), appearance.displayName)}
            </p>
          </div>
          <div className="grid grid-cols-2 gap-2">
            {[
              { icon: CircleDollarSign, label: "Spend", value: "$482.19" },
              { icon: Zap, label: "Tokens", value: "128.4M" },
            ].map((stat, index) => (
              <div key={stat.label} className="surface-card p-2.5">
                <div className="flex items-center justify-between text-[10px] text-muted-foreground">
                  {stat.label}
                  <stat.icon className="size-3 text-primary" />
                </div>
                <div className="font-heading text-sm font-semibold tabular-nums">
                  {stat.value}
                </div>
                <Sparkline
                  className="h-5"
                  values={
                    index === 0 ? PREVIEW_BARS : PREVIEW_BARS.toReversed()
                  }
                />
              </div>
            ))}
          </div>
          <div className="surface-card p-2.5">
            <div className="text-[10px] font-medium">Spend over time</div>
            <div className="mt-2 flex h-16 items-end gap-1">
              {PREVIEW_BARS.map((height, index) => (
                <span
                  // oxlint-disable-next-line react/no-array-index-key -- static decorative bars
                  key={index}
                  className="flex-1 rounded-t-[calc(var(--radius)*0.4)]"
                  style={{
                    background:
                      "linear-gradient(to top, color-mix(in oklch, var(--chart-1) 55%, transparent), var(--chart-1))",
                    height: `${height}%`,
                  }}
                />
              ))}
            </div>
          </div>
          <div className="surface-card space-y-1.5 p-2.5">
            <div className="flex h-1.5 gap-0.5 overflow-hidden rounded-full">
              {PREVIEW_SHARES.map((entry, index) => (
                <span
                  key={entry.name}
                  style={{
                    background: SERIES_COLORS[index],
                    width: `${entry.share}%`,
                  }}
                />
              ))}
            </div>
            <div className="flex flex-wrap gap-x-3 gap-y-1">
              {PREVIEW_SHARES.map((entry, index) => (
                <span
                  key={entry.name}
                  className="flex items-center gap-1 text-[9px] text-muted-foreground"
                >
                  <span
                    className="size-1.5 rounded-full"
                    style={{ background: SERIES_COLORS[index] }}
                  />
                  {entry.name} {entry.share}%
                </span>
              ))}
            </div>
          </div>
          <div className="flex gap-2">
            <span className="rounded-lg bg-primary px-2.5 py-1 text-[10px] font-medium text-primary-foreground">
              Primary action
            </span>
            <span className="rounded-lg border bg-card px-2.5 py-1 text-[10px] font-medium">
              Secondary
            </span>
          </div>
        </div>
      </div>
    </div>
  );
};
