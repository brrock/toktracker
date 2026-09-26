import { Bot, Boxes, Cpu, Inbox } from "lucide-react";
import { useId } from "react";

import { cn } from "@/lib/utils";

const AGENT_LOGOS = {
  claude: "/agent-logos/client-claude.jpg",
  codex: "/agent-logos/client-openai.jpg",
  copilot: "/agent-logos/client-copilot.jpg",
  cursor: "/agent-logos/client-cursor.png",
  hermes: "/agent-logos/client-hermes.png",
  openclaw: "/agent-logos/client-openclaw.jpg",
  opencode: "/agent-logos/client-opencode.png",
  pi: "/agent-logos/client-pi.png",
} satisfies Record<string, string>;

export const BrandMark = ({ className }: { className?: string }) => (
  <span
    className={cn(
      "brand-gradient grid size-8 shrink-0 place-items-center rounded-[calc(var(--radius)*1.1)] text-white shadow-[0_6px_18px_-6px_var(--primary)]",
      className
    )}
  >
    <svg viewBox="0 0 24 24" aria-hidden="true" className="size-[58%]">
      <rect
        x="3"
        y="12"
        width="4.2"
        height="9"
        rx="2.1"
        fill="currentColor"
        opacity="0.7"
      />
      <rect
        x="9.9"
        y="7.5"
        width="4.2"
        height="13.5"
        rx="2.1"
        fill="currentColor"
        opacity="0.85"
      />
      <rect
        x="16.8"
        y="3"
        width="4.2"
        height="18"
        rx="2.1"
        fill="currentColor"
      />
    </svg>
  </span>
);

export const AgentLogo = ({
  name,
  size = "size-6",
}: {
  name: string;
  size?: string;
}) => {
  const source = Object.entries(AGENT_LOGOS).find(
    ([agent]) => agent === name.toLowerCase()
  )?.[1];
  return source ? (
    <img
      src={source}
      alt=""
      className={`${size} shrink-0 rounded-[calc(var(--radius)*0.6)] object-cover ring-1 ring-border`}
    />
  ) : (
    <span
      className={`grid ${size} shrink-0 place-items-center rounded-[calc(var(--radius)*0.6)] bg-primary/10 text-primary`}
    >
      <Bot className="size-1/2" />
    </span>
  );
};

export const BreakdownIcon = ({
  kind,
  name,
}: {
  kind: "agent" | "model" | "project";
  name: string;
}) => {
  if (kind === "agent") {
    return <AgentLogo name={name} size="size-5" />;
  }
  if (kind === "project") {
    return <Boxes className="size-4 shrink-0 text-muted-foreground" />;
  }
  return <Cpu className="size-4 shrink-0 text-muted-foreground" />;
};

export const Card = ({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) => <div className={cn("surface-card p-5", className)}>{children}</div>;

export const CardHeader = ({
  action,
  description,
  title,
}: {
  action?: React.ReactNode;
  description?: React.ReactNode;
  title: string;
}) => (
  <div className="flex flex-wrap items-start justify-between gap-3">
    <div className="min-w-0">
      <h3 className="font-semibold">{title}</h3>
      {description && (
        <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>
      )}
    </div>
    {action}
  </div>
);

export const EmptyState = ({
  children,
  icon,
}: {
  children: React.ReactNode;
  icon?: React.ReactNode;
}) => (
  <div className="grid place-items-center gap-3 rounded-xl border border-dashed px-6 py-14 text-center text-sm text-muted-foreground">
    <span className="grid size-10 place-items-center rounded-full bg-muted text-muted-foreground [&>svg]:size-5">
      {icon ?? <Inbox />}
    </span>
    <div className="max-w-sm">{children}</div>
  </div>
);

export const Skeleton = ({ className }: { className?: string }) => (
  <div aria-hidden="true" className={cn("skeleton", className)} />
);

export const Sparkline = ({
  className,
  values,
}: {
  className?: string;
  values: number[];
}) => {
  const gradientId = useId();
  if (values.length < 2) {
    return null;
  }
  const width = 120;
  const height = 36;
  const maximum = Math.max(...values, 1);
  const step = width / (values.length - 1);
  const points = values.map(
    (value, index) =>
      `${(index * step).toFixed(1)},${(height - 2 - (value / maximum) * (height - 6)).toFixed(1)}`
  );
  const line = `M${points.join(" L")}`;
  return (
    <svg
      aria-hidden="true"
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      className={cn("h-9 w-full overflow-visible text-primary", className)}
    >
      <defs>
        <linearGradient id={gradientId} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor="currentColor" stopOpacity="0.28" />
          <stop offset="1" stopColor="currentColor" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path
        d={`${line} L${width},${height} L0,${height} Z`}
        fill={`url(#${gradientId})`}
      />
      <path
        d={line}
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.75"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
};

export const Stat = ({
  icon,
  label,
  note,
  trend,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  note: string;
  trend?: number[];
  value: string;
}) => (
  <Card className="group relative overflow-hidden">
    <div className="flex items-center justify-between">
      <span className="text-sm font-medium text-muted-foreground">{label}</span>
      <span className="grid size-8 place-items-center rounded-lg bg-primary/10 text-primary ring-1 ring-primary/15 transition group-hover:scale-105 [&>svg]:size-4">
        {icon}
      </span>
    </div>
    <div className="mt-4 truncate font-heading text-2xl font-semibold tabular-nums tracking-tight">
      {value}
    </div>
    <p className="mt-1 truncate text-xs text-muted-foreground" title={note}>
      {note}
    </p>
    {trend && trend.length > 1 && (
      <Sparkline values={trend} className="mt-3 -mb-1" />
    )}
  </Card>
);

export const Metric = ({ label, value }: { label: string; value: string }) => (
  <div>
    <div className="font-semibold tabular-nums">{value}</div>
    <div className="text-xs text-muted-foreground">{label}</div>
  </div>
);

// A visually custom radio option backed by a native radio input, so arrow
// keys, focus and screen readers behave like any other radio group.
export const ChoiceOption = ({
  checked,
  children,
  className,
  name,
  onSelect,
  style,
  title,
}: {
  checked: boolean;
  children: React.ReactNode;
  className?: string;
  name: string;
  onSelect: () => void;
  style?: React.CSSProperties;
  title?: string;
}) => (
  <label
    style={style}
    title={title}
    className={cn(
      "cursor-pointer has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-ring",
      className
    )}
  >
    <input
      type="radio"
      name={name}
      checked={checked}
      onChange={onSelect}
      className="sr-only"
    />
    {children}
  </label>
);

export const ChoiceGroup = ({
  children,
  className,
  label,
}: {
  children: React.ReactNode;
  className?: string;
  label: string;
}) => (
  <fieldset className={className}>
    <legend className="sr-only">{label}</legend>
    {children}
  </fieldset>
);

export const SegmentedControl = <T extends string>({
  label,
  onChange,
  options,
  size = "sm",
  value,
}: {
  label: string;
  onChange: (value: T) => void;
  options: readonly { label: string; value: T }[];
  size?: "sm" | "md";
  value: T;
}) => {
  const name = useId();
  return (
    <ChoiceGroup
      label={label}
      className="inline-flex max-w-full shrink-0 overflow-x-auto rounded-lg border bg-muted/60 p-0.5"
    >
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <ChoiceOption
            key={option.value}
            name={name}
            checked={selected}
            onSelect={() => onChange(option.value)}
            className={cn(
              "flex items-center whitespace-nowrap rounded-[calc(var(--radius)*0.75)] font-medium transition",
              size === "sm" ? "h-7 px-2.5 text-xs" : "h-8 px-3 text-sm",
              selected
                ? "bg-card text-foreground shadow-sm ring-1 ring-border"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            {option.label}
          </ChoiceOption>
        );
      })}
    </ChoiceGroup>
  );
};

export const METRIC_OPTIONS = [
  { label: "Cost", value: "cost" },
  { label: "Tokens", value: "tokens" },
] as const;

export const PageSkeleton = () => (
  <div aria-busy="true" aria-label="Loading usage" className="space-y-4">
    <div className="space-y-2">
      <Skeleton className="h-3 w-32" />
      <Skeleton className="h-8 w-72" />
      <Skeleton className="h-4 w-96 max-w-full" />
    </div>
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      {["spend", "tokens", "sessions", "model"].map((tile) => (
        <Skeleton key={tile} className="h-36 rounded-xl" />
      ))}
    </div>
    <div className="grid gap-4 xl:grid-cols-[1.6fr_1fr]">
      <Skeleton className="h-96 rounded-xl" />
      <Skeleton className="h-96 rounded-xl" />
    </div>
  </div>
);
