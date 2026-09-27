import type { DashboardSummary } from "@toktracker/shared";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  CircleDollarSign,
  Copy,
  Keyboard,
  Laptop,
  Layers,
  Lock,
  Palette,
  Rocket,
  Search,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { useEffect, useState } from "react";

import { useAppearance } from "@/components/theme-provider";
import { apiFetch } from "@/lib/api";
import { relativeTime } from "@/lib/dashboard";
import { CLIENT_INSTALL_COMMANDS } from "@/lib/onboarding";
import { dashboardSummarySchema } from "@/lib/schemas";
import { cn } from "@/lib/utils";

import {
  AccentPicker,
  FontPicker,
  ModePicker,
  SurfacePicker,
} from "./appearance-controls";
import { AppearancePreview } from "./appearance-preview";
import { AgentLogo, BrandMark, SegmentedControl } from "./primitives";

const STEPS = [
  { icon: Sparkles, label: "Welcome" },
  { icon: Palette, label: "Make it yours" },
  { icon: Laptop, label: "Connect a machine" },
  { icon: Rocket, label: "Ready" },
] as const;

const DEVICE_POLL_INTERVAL_MS = 4000;
const COPY_FEEDBACK_MS = 1600;
const FEATURED_AGENTS = [
  "claude",
  "codex",
  "cursor",
  "copilot",
  "opencode",
  "pi",
  "hermes",
];

type Devices = DashboardSummary["devices"];

const useConnectedDevices = (initial: Devices, polling: boolean): Devices => {
  const [devices, setDevices] = useState(initial);
  useEffect(() => {
    if (!polling) {
      return;
    }
    const controller = new AbortController();
    const load = async (): Promise<void> => {
      try {
        const response = await apiFetch(
          "/api/v1/summary?range=day&includeAllDevices=true",
          { signal: controller.signal }
        );
        if (response.ok) {
          setDevices(
            dashboardSummarySchema.parse(await response.json()).devices
          );
        }
      } catch {
        // Keep showing the last known devices while the gateway is busy.
      }
    };
    load();
    const interval = window.setInterval(load, DEVICE_POLL_INTERVAL_MS);
    return () => {
      controller.abort();
      window.clearInterval(interval);
    };
  }, [polling]);
  return devices;
};

const CopyField = ({ label, value }: { label: string; value: string }) => {
  const [copied, setCopied] = useState(false);
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), COPY_FEEDBACK_MS);
    } catch {
      setCopied(false);
    }
  };
  return (
    <div className="group flex items-center gap-2 rounded-lg border bg-muted/50 py-1.5 pr-1.5 pl-3">
      <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap font-mono text-xs">
        {value}
      </code>
      <button
        type="button"
        aria-label={`Copy ${label}`}
        onClick={copy}
        className={cn(
          "grid size-7 shrink-0 place-items-center rounded-md border bg-card transition",
          copied
            ? "text-success"
            : "text-muted-foreground hover:text-foreground"
        )}
      >
        {copied ? (
          <Check className="size-3.5" />
        ) : (
          <Copy className="size-3.5" />
        )}
      </button>
    </div>
  );
};

const WelcomeStep = () => {
  const { appearance, updateAppearance } = useAppearance();
  const features = [
    {
      description: "Reported and estimated spend for every session.",
      icon: CircleDollarSign,
      title: "Every token, priced",
    },
    {
      description: "One dashboard for all your machines and coding agents.",
      icon: Layers,
      title: "All agents, one view",
    },
    {
      description: "Self-hosted. Your data never leaves your gateway.",
      icon: ShieldCheck,
      title: "Private by design",
    },
  ];
  return (
    <div className="space-y-8">
      <div>
        <BrandMark className="size-14 animate-pulse-ring rounded-2xl" />
        <h1 className="gradient-heading mt-6 text-4xl font-semibold leading-tight sm:text-5xl">
          Know exactly what your agents cost.
        </h1>
        <p className="mt-3 max-w-lg text-base text-muted-foreground">
          TokTracker turns the session logs your coding agents already write
          into a live picture of tokens, spend and activity. Let’s get you set
          up — it takes about a minute.
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {FEATURED_AGENTS.map((agent) => (
          <AgentLogo key={agent} name={agent} size="size-8" />
        ))}
        <span className="text-xs text-muted-foreground">+ more</span>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        {features.map((feature) => (
          <div key={feature.title} className="surface-card p-4">
            <feature.icon className="size-5 text-primary" />
            <p className="mt-3 text-sm font-semibold">{feature.title}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {feature.description}
            </p>
          </div>
        ))}
      </div>
      <label className="block max-w-sm space-y-1.5">
        <span className="text-sm font-medium">What should we call you?</span>
        <input
          autoComplete="name"
          className="h-11 w-full rounded-lg border bg-card px-3.5 text-sm outline-none transition focus:border-primary focus:ring-3 focus:ring-primary/20"
          maxLength={48}
          placeholder="Your first name (optional)"
          value={appearance.displayName}
          onChange={(event) =>
            updateAppearance({ displayName: event.target.value })
          }
        />
      </label>
    </div>
  );
};

const StyleStep = () => (
  <div className="grid gap-8 xl:grid-cols-[1fr_minmax(0,24rem)]">
    <div className="space-y-6">
      <div>
        <h2 className="text-3xl font-semibold">Make it yours</h2>
        <p className="mt-2 text-muted-foreground">
          Pick a vibe. Everything updates live, and you can fine-tune it any
          time from Settings → Appearance.
        </p>
      </div>
      <section className="space-y-2.5">
        <h3 className="text-sm font-medium">Mode</h3>
        <ModePicker />
      </section>
      <section className="space-y-2.5">
        <h3 className="text-sm font-medium">Accent</h3>
        <AccentPicker />
      </section>
      <section className="space-y-2.5">
        <h3 className="text-sm font-medium">Typeface</h3>
        <FontPicker />
      </section>
      <section className="space-y-2.5">
        <h3 className="text-sm font-medium">Surface</h3>
        <SurfacePicker />
      </section>
    </div>
    <div className="hidden xl:block">
      <div className="sticky top-0">
        <p className="mb-3 text-xs font-medium uppercase tracking-caps text-muted-foreground">
          Live preview
        </p>
        <AppearancePreview />
      </div>
    </div>
  </div>
);

const ConnectStep = ({ devices }: { devices: Devices }) => {
  const [platform, setPlatform] = useState<"unix" | "windows">(() =>
    navigator.userAgent.includes("Windows") ? "windows" : "unix"
  );
  const command =
    CLIENT_INSTALL_COMMANDS.find((option) => option.id === platform)?.command ??
    "";
  const gatewayUrl = window.location.origin;
  const connected = devices.length > 0;
  return (
    <div className="space-y-7">
      <div>
        <h2 className="text-3xl font-semibold">Connect a machine</h2>
        <p className="mt-2 max-w-xl text-muted-foreground">
          Install the lightweight client on every computer you code on. It reads
          local agent sessions and uploads usage to this gateway in the
          background.
        </p>
      </div>
      <ol className="space-y-5">
        <li className="flex gap-4">
          <span className="grid size-7 shrink-0 place-items-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
            1
          </span>
          <div className="min-w-0 flex-1 space-y-2.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm font-medium">Run the installer</p>
              <SegmentedControl
                label="Platform"
                options={CLIENT_INSTALL_COMMANDS.map((option) => ({
                  label: option.label,
                  value: option.id,
                }))}
                value={platform}
                onChange={setPlatform}
              />
            </div>
            <CopyField label="install command" value={command} />
          </div>
        </li>
        <li className="flex gap-4">
          <span className="grid size-7 shrink-0 place-items-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
            2
          </span>
          <div className="min-w-0 flex-1 space-y-2.5">
            <p className="text-sm font-medium">
              When asked for the gateway URL, paste
            </p>
            <CopyField label="gateway URL" value={gatewayUrl} />
            <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
              <Lock className="mt-0.5 size-3 shrink-0" />
              If this gateway uses an ingestion key, the installer asks for it
              next. Leave it blank when there is none.
            </p>
          </div>
        </li>
        <li className="flex gap-4">
          <span
            className={cn(
              "grid size-7 shrink-0 place-items-center rounded-full text-xs font-semibold",
              connected
                ? "bg-success/15 text-success"
                : "bg-primary/10 text-primary"
            )}
          >
            {connected ? <Check className="size-3.5" /> : "3"}
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">Watch it show up</p>
            <div className="mt-2.5 surface-card p-4">
              {connected ? (
                <div className="space-y-2.5">
                  {devices.slice(0, 4).map((device) => (
                    <div
                      key={device.id}
                      className="flex items-center gap-3 text-sm"
                    >
                      <span className="size-2 rounded-full bg-success shadow-halo-success" />
                      <span className="min-w-0 flex-1 truncate font-medium">
                        {device.name}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {device.platform} · {relativeTime(device.lastSeen)}
                      </span>
                    </div>
                  ))}
                  <p className="pt-1 text-xs text-muted-foreground">
                    {devices.length} machine{devices.length === 1 ? "" : "s"}{" "}
                    reporting. Add more any time.
                  </p>
                </div>
              ) : (
                <div className="flex items-center gap-3 text-sm text-muted-foreground">
                  <span className="relative flex size-2.5">
                    <span className="absolute inline-flex size-full animate-ping rounded-full bg-primary/60" />
                    <span className="relative inline-flex size-2.5 rounded-full bg-primary" />
                  </span>
                  Waiting for the first machine to check in…
                </div>
              )}
            </div>
          </div>
        </li>
      </ol>
    </div>
  );
};

const ReadyStep = () => {
  const { appearance } = useAppearance();
  const name = appearance.displayName.trim();
  const shortcuts = [
    { icon: Search, keys: ["⌘", "K"], label: "Search everything" },
    { icon: Palette, keys: ["D"], label: "Toggle light / dark" },
    { icon: Keyboard, keys: ["Esc"], label: "Close dialogs" },
  ];
  return (
    <div className="space-y-8">
      <div>
        <span className="grid size-14 place-items-center rounded-2xl bg-success/15 text-success">
          <Check className="size-7" />
        </span>
        <h2 className="mt-6 text-4xl font-semibold">
          You’re all set{name ? `, ${name}` : ""}.
        </h2>
        <p className="mt-3 max-w-lg text-muted-foreground">
          Usage appears as soon as a client syncs. A few shortcuts to keep in
          your back pocket:
        </p>
      </div>
      <div className="grid max-w-xl gap-2">
        {shortcuts.map((shortcut) => (
          <div
            key={shortcut.label}
            className="surface-card flex items-center gap-3 px-4 py-3"
          >
            <shortcut.icon className="size-4 text-primary" />
            <span className="flex-1 text-sm">{shortcut.label}</span>
            <span className="flex gap-1">
              {shortcut.keys.map((key) => (
                <kbd
                  key={key}
                  className="grid h-6 min-w-6 place-items-center rounded-md border bg-muted px-1.5 font-mono text-2xs"
                >
                  {key}
                </kbd>
              ))}
            </span>
          </div>
        ))}
      </div>
      <p className="text-sm text-muted-foreground">
        You can replay this tour from Settings → Appearance.
      </p>
    </div>
  );
};

export const Onboarding = ({
  devices,
  onFinish,
}: {
  devices: Devices;
  onFinish: () => void;
}) => {
  const [step, setStep] = useState(0);
  const connectedDevices = useConnectedDevices(devices, step === 2);
  const isLast = step === STEPS.length - 1;
  const next = (): void => (isLast ? onFinish() : setStep(step + 1));
  let nextLabel = "Continue";
  if (isLast) {
    nextLabel = "Open my dashboard";
  } else if (step === 2 && connectedDevices.length === 0) {
    nextLabel = "I’ll do this later";
  }

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        onFinish();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onFinish]);

  return (
    <section
      aria-label="Set up TokTracker"
      className="fixed inset-0 z-50 flex bg-background"
    >
      <div className="app-backdrop" />
      <aside className="relative hidden w-72 shrink-0 flex-col border-r bg-sidebar/70 p-8 backdrop-blur lg:flex">
        <div className="flex items-center gap-3">
          <BrandMark />
          <span className="font-heading font-semibold">TokTracker</span>
        </div>
        <ol className="mt-12 space-y-1">
          {STEPS.map((item, index) => {
            const done = index < step;
            const current = index === step;
            return (
              <li key={item.label}>
                <button
                  type="button"
                  disabled={index > step}
                  onClick={() => setStep(index)}
                  className={cn(
                    "flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm transition disabled:cursor-default",
                    current && "bg-primary/10 font-medium text-foreground",
                    !current && "text-muted-foreground",
                    done && "hover:bg-muted hover:text-foreground"
                  )}
                >
                  <span
                    className={cn(
                      "grid size-6 place-items-center rounded-full border text-2xs transition",
                      current &&
                        "border-primary bg-primary text-primary-foreground",
                      done && "border-success/40 bg-success/15 text-success"
                    )}
                  >
                    {done ? <Check className="size-3" /> : index + 1}
                  </span>
                  {item.label}
                </button>
              </li>
            );
          })}
        </ol>
        <p className="mt-auto text-xs text-muted-foreground">
          Self-hosted usage intelligence for AI coding agents.
        </p>
      </aside>
      <div className="relative flex min-w-0 flex-1 flex-col">
        <div className="flex items-center justify-between gap-4 px-6 pt-6 sm:px-10">
          <div className="flex items-center gap-3 lg:invisible">
            <BrandMark className="size-7" />
            <span className="text-xs text-muted-foreground">
              Step {step + 1} of {STEPS.length}
            </span>
          </div>
          <button
            type="button"
            onClick={onFinish}
            className="text-sm text-muted-foreground transition hover:text-foreground"
          >
            Skip setup
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-8 sm:px-10 lg:px-16">
          <div key={step} className="animate-rise mx-auto max-w-5xl">
            {step === 0 && <WelcomeStep />}
            {step === 1 && <StyleStep />}
            {step === 2 && <ConnectStep devices={connectedDevices} />}
            {step === 3 && <ReadyStep />}
          </div>
        </div>
        <div className="border-t bg-background/80 px-6 py-4 backdrop-blur sm:px-10 lg:px-16">
          <div className="mx-auto flex max-w-5xl items-center gap-4">
            <div className="flex flex-1 gap-1.5">
              {STEPS.map((item, index) => (
                <span
                  key={item.label}
                  className={cn(
                    "h-1.5 rounded-full transition-all duration-500",
                    index === step ? "w-8 bg-primary" : "w-1.5 bg-border",
                    index < step && "bg-primary/50"
                  )}
                />
              ))}
            </div>
            {step > 0 && (
              <button
                type="button"
                onClick={() => setStep(step - 1)}
                className="inline-flex h-10 items-center gap-2 rounded-lg border bg-card px-4 text-sm font-medium transition hover:bg-muted"
              >
                <ArrowLeft className="size-4" />
                Back
              </button>
            )}
            <button
              type="button"
              onClick={next}
              className="brand-gradient inline-flex h-10 items-center gap-2 rounded-lg px-5 text-sm font-medium text-primary-foreground shadow-glow-lg transition hover:brightness-110"
            >
              {nextLabel}
              <ArrowRight className="size-4" />
            </button>
          </div>
        </div>
      </div>
    </section>
  );
};
