import { Popover } from "@base-ui/react/popover";
import { Check, Monitor, Moon, Palette, Pipette, Sun } from "lucide-react";
import { useId } from "react";
import { useNavigate } from "react-router-dom";

import { useAppearance } from "@/components/theme-provider";
import {
  ACCENT_PRESETS,
  accentColor,
  BACKDROP_OPTIONS,
  DENSITY_OPTIONS,
  FONT_OPTIONS,
  RADIUS_OPTIONS,
  SURFACE_OPTIONS,
} from "@/lib/appearance";
import { cn } from "@/lib/utils";

import { ChoiceGroup, ChoiceOption, SegmentedControl } from "./primitives";

const MODES = [
  { icon: Sun, label: "Light", value: "light" },
  { icon: Moon, label: "Dark", value: "dark" },
  { icon: Monitor, label: "System", value: "system" },
] as const;

const swatch = (hue: number, chroma: number): string =>
  `linear-gradient(135deg, oklch(0.8 ${chroma} ${hue + 25}), oklch(0.62 ${chroma} ${hue}) 55%, oklch(0.48 ${chroma} ${hue - 25}))`;

export const ModePicker = ({ compact = false }: { compact?: boolean }) => {
  const { appearance, setMode } = useAppearance();
  const name = useId();
  return (
    <ChoiceGroup
      label="Colour mode"
      className={cn("grid grid-cols-3 gap-2", compact && "gap-1.5")}
    >
      {MODES.map((option) => {
        const Icon = option.icon;
        const selected = appearance.mode === option.value;
        return (
          <ChoiceOption
            key={option.value}
            name={name}
            checked={selected}
            onSelect={() => setMode(option.value)}
            className={cn(
              "flex items-center justify-center gap-2 rounded-lg border text-sm font-medium transition",
              compact ? "h-8 text-xs" : "h-10",
              selected
                ? "border-primary bg-primary/10 text-foreground ring-1 ring-primary"
                : "bg-card text-muted-foreground hover:border-foreground/20 hover:text-foreground"
            )}
          >
            <Icon className="size-4" />
            {option.label}
          </ChoiceOption>
        );
      })}
    </ChoiceGroup>
  );
};

export const AccentPicker = ({
  showCustom = true,
}: {
  showCustom?: boolean;
}) => {
  const { appearance, updateAppearance } = useAppearance();
  const custom = appearance.accent === "custom";
  const name = useId();
  return (
    <div className="space-y-3">
      <ChoiceGroup label="Accent colour" className="flex flex-wrap gap-2">
        {ACCENT_PRESETS.map((preset) => {
          const selected = appearance.accent === preset.id;
          return (
            <ChoiceOption
              key={preset.id}
              name={name}
              checked={selected}
              title={preset.label}
              onSelect={() => updateAppearance({ accent: preset.id })}
              className={cn(
                "grid size-8 place-items-center rounded-full ring-offset-2 ring-offset-background transition hover:scale-110",
                selected && "ring-2 ring-foreground/70"
              )}
              style={{ background: swatch(preset.hue, preset.chroma) }}
            >
              <span className="sr-only">{preset.label}</span>
              {selected && <Check className="size-4 text-white drop-shadow" />}
            </ChoiceOption>
          );
        })}
        {showCustom && (
          <ChoiceOption
            name={name}
            checked={custom}
            title="Custom colour"
            onSelect={() => updateAppearance({ accent: "custom" })}
            className={cn(
              "grid size-8 place-items-center rounded-full ring-offset-2 ring-offset-background transition hover:scale-110",
              custom && "ring-2 ring-foreground/70"
            )}
            style={{
              background:
                "conic-gradient(oklch(0.7 0.17 0), oklch(0.7 0.17 60), oklch(0.7 0.17 120), oklch(0.7 0.17 180), oklch(0.7 0.17 240), oklch(0.7 0.17 300), oklch(0.7 0.17 360))",
            }}
          >
            <span className="sr-only">Custom colour</span>
            <Pipette className="size-3.5 text-white drop-shadow" />
          </ChoiceOption>
        )}
      </ChoiceGroup>
      {showCustom && custom && (
        <div className="space-y-2 text-xs text-muted-foreground">
          <div className="flex justify-between">
            <span>Custom hue</span>
            <span className="tabular-nums">{appearance.customHue}°</span>
          </div>
          <input
            type="range"
            aria-label="Custom hue"
            min={0}
            max={359}
            value={appearance.customHue}
            onChange={(event) =>
              updateAppearance({ customHue: Number(event.target.value) })
            }
            className="h-2 w-full cursor-pointer appearance-none rounded-full [&::-webkit-slider-thumb]:size-4 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-white [&::-webkit-slider-thumb]:bg-primary [&::-webkit-slider-thumb]:shadow"
            style={{
              background:
                "linear-gradient(90deg, oklch(0.7 0.17 0), oklch(0.7 0.17 60), oklch(0.7 0.17 120), oklch(0.7 0.17 180), oklch(0.7 0.17 240), oklch(0.7 0.17 300), oklch(0.7 0.17 359))",
            }}
          />
        </div>
      )}
    </div>
  );
};

export const SurfacePicker = () => {
  const { appearance, updateAppearance } = useAppearance();
  const accent = accentColor(appearance);
  const previews = {
    neutral: ["oklch(0.98 0 0)", "oklch(0.2 0 0)"],
    oled: ["oklch(0.98 0 0)", "oklch(0 0 0)"],
    slate: ["oklch(0.98 0.01 255)", "oklch(0.2 0.025 255)"],
    stone: ["oklch(0.98 0.008 60)", "oklch(0.2 0.013 60)"],
    tinted: [
      `oklch(0.97 0.025 ${accent.hue})`,
      `oklch(0.21 0.035 ${accent.hue})`,
    ],
  } as const;
  const name = useId();
  return (
    <ChoiceGroup
      label="Surface"
      className="grid grid-cols-2 gap-2 sm:grid-cols-5"
    >
      {SURFACE_OPTIONS.map((option) => {
        const selected = appearance.surface === option.id;
        const [light, dark] = previews[option.id];
        return (
          <ChoiceOption
            key={option.id}
            name={name}
            checked={selected}
            onSelect={() => updateAppearance({ surface: option.id })}
            className={cn(
              "overflow-hidden rounded-lg border text-left transition",
              selected
                ? "border-primary ring-1 ring-primary"
                : "hover:border-foreground/20"
            )}
          >
            <span
              className="block h-10"
              style={{
                background: `linear-gradient(115deg, ${light} 0 50%, ${dark} 50% 100%)`,
              }}
            />
            <span className="block bg-card px-2.5 py-2">
              <span className="block text-xs font-medium">{option.label}</span>
              <span className="block truncate text-[10px] text-muted-foreground">
                {option.description}
              </span>
            </span>
          </ChoiceOption>
        );
      })}
    </ChoiceGroup>
  );
};

const FONT_FAMILIES = {
  editorial: '"Fraunces Variable", serif',
  geist: '"Geist Variable", sans-serif',
  grotesk: '"Space Grotesk Variable", sans-serif',
  inter: '"Inter Variable", sans-serif',
  manrope: '"Manrope Variable", sans-serif',
  plex: '"IBM Plex Sans Variable", sans-serif',
  terminal: '"JetBrains Mono Variable", monospace',
} as const;

export const FontPicker = ({ limit }: { limit?: number }) => {
  const { appearance, updateAppearance } = useAppearance();
  const name = useId();
  return (
    <ChoiceGroup
      label="Typeface"
      className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4"
    >
      {FONT_OPTIONS.slice(0, limit).map((option) => {
        const selected = appearance.font === option.id;
        return (
          <ChoiceOption
            key={option.id}
            name={name}
            checked={selected}
            onSelect={() => updateAppearance({ font: option.id })}
            className={cn(
              "rounded-lg border bg-card px-3 py-2.5 text-left transition",
              selected
                ? "border-primary ring-1 ring-primary"
                : "hover:border-foreground/20"
            )}
          >
            <span
              className="block text-xl leading-tight"
              style={{ fontFamily: FONT_FAMILIES[option.id] }}
            >
              Aa
            </span>
            <span className="mt-1 block text-xs font-medium">
              {option.label}
            </span>
            <span className="block truncate text-[10px] text-muted-foreground">
              {option.note}
            </span>
          </ChoiceOption>
        );
      })}
    </ChoiceGroup>
  );
};

export const DetailPickers = () => {
  const { appearance, updateAppearance } = useAppearance();
  return (
    <div className="grid gap-4 sm:grid-cols-3">
      <div className="space-y-2">
        <p className="text-xs font-medium text-muted-foreground">Corners</p>
        <SegmentedControl
          label="Corner radius"
          options={RADIUS_OPTIONS.map((option) => ({
            label: option.label,
            value: option.id,
          }))}
          value={appearance.radius}
          onChange={(radius) => updateAppearance({ radius })}
        />
      </div>
      <div className="space-y-2">
        <p className="text-xs font-medium text-muted-foreground">Density</p>
        <SegmentedControl
          label="Density"
          options={DENSITY_OPTIONS.map((option) => ({
            label: option.label,
            value: option.id,
          }))}
          value={appearance.density}
          onChange={(density) => updateAppearance({ density })}
        />
      </div>
      <div className="space-y-2">
        <p className="text-xs font-medium text-muted-foreground">Backdrop</p>
        <SegmentedControl
          label="Backdrop"
          options={BACKDROP_OPTIONS.map((option) => ({
            label: option.label,
            value: option.id,
          }))}
          value={appearance.backdrop}
          onChange={(backdrop) => updateAppearance({ backdrop })}
        />
      </div>
    </div>
  );
};

export const QuickAppearanceMenu = () => {
  const navigate = useNavigate();
  const { resolvedMode } = useAppearance();
  const ModeIcon = resolvedMode === "dark" ? Moon : Sun;
  return (
    <Popover.Root>
      <Popover.Trigger
        aria-label="Appearance"
        title="Appearance"
        className="relative grid size-9 shrink-0 place-items-center rounded-lg border bg-card text-muted-foreground transition hover:text-foreground data-[popup-open]:text-foreground"
      >
        <Palette className="size-4" />
        <span className="absolute -right-0.5 -bottom-0.5 grid size-4 place-items-center rounded-full border bg-card">
          <ModeIcon className="size-2.5" />
        </span>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner sideOffset={8} align="end" className="z-50">
          <Popover.Popup className="w-[22rem] origin-[var(--transform-origin)] rounded-xl border bg-popover p-4 text-popover-foreground shadow-xl transition data-[ending-style]:scale-95 data-[ending-style]:opacity-0 data-[starting-style]:scale-95 data-[starting-style]:opacity-0">
            <Popover.Title className="text-sm font-semibold">
              Appearance
            </Popover.Title>
            <Popover.Description className="text-xs text-muted-foreground">
              Changes apply instantly and are saved in this browser.
            </Popover.Description>
            <div className="mt-4 space-y-4">
              <ModePicker compact />
              <div className="space-y-2">
                <p className="text-xs font-medium text-muted-foreground">
                  Accent
                </p>
                <AccentPicker showCustom={false} />
              </div>
            </div>
            <Popover.Close
              onClick={() => navigate("/settings/appearance")}
              className="mt-4 flex h-8 w-full items-center justify-center rounded-lg border text-xs font-medium transition hover:bg-muted"
            >
              Fonts, surfaces & more…
            </Popover.Close>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
};
