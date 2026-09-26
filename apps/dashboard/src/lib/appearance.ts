import { z } from "zod";

export const APPEARANCE_STORAGE_KEY = "toktracker-appearance";
// A precomputed copy of the root attributes, read by /appearance-boot.js so
// the first paint already uses the saved theme (the CSP forbids inline code).
export const APPEARANCE_BOOT_STORAGE_KEY = "toktracker-appearance-boot";
export const LEGACY_THEME_STORAGE_KEY = "toktracker-theme";

export const MODE_OPTIONS = ["light", "dark", "system"] as const;
export type AppearanceMode = (typeof MODE_OPTIONS)[number];
export type ResolvedMode = "dark" | "light";

export const ACCENT_PRESETS = [
  { chroma: 0.19, hue: 42, id: "ember", label: "Ember" },
  { chroma: 0.16, hue: 75, id: "amber", label: "Amber" },
  { chroma: 0.17, hue: 135, id: "lime", label: "Lime" },
  { chroma: 0.15, hue: 162, id: "emerald", label: "Emerald" },
  { chroma: 0.12, hue: 200, id: "lagoon", label: "Lagoon" },
  { chroma: 0.17, hue: 250, id: "ocean", label: "Ocean" },
  { chroma: 0.19, hue: 278, id: "indigo", label: "Indigo" },
  { chroma: 0.2, hue: 305, id: "orchid", label: "Orchid" },
  { chroma: 0.2, hue: 355, id: "rose", label: "Rose" },
] as const;
export type AccentPresetId = (typeof ACCENT_PRESETS)[number]["id"];
const CUSTOM_ACCENT_CHROMA = 0.17;

export const SURFACE_OPTIONS = [
  {
    description: "Warm, papery neutrals",
    id: "stone",
    label: "Stone",
  },
  {
    description: "Cool blue-grey",
    id: "slate",
    label: "Slate",
  },
  {
    description: "Pure greyscale",
    id: "neutral",
    label: "Neutral",
  },
  {
    description: "Washed in your accent",
    id: "tinted",
    label: "Tinted",
  },
  {
    description: "True black in dark mode",
    id: "oled",
    label: "OLED",
  },
] as const;
export type SurfaceId = (typeof SURFACE_OPTIONS)[number]["id"];

export const FONT_OPTIONS = [
  { heading: "Geist", id: "geist", label: "Geist", note: "Crisp & modern" },
  { heading: "Inter", id: "inter", label: "Inter", note: "Neutral workhorse" },
  {
    heading: "Manrope",
    id: "manrope",
    label: "Manrope",
    note: "Rounded & friendly",
  },
  {
    heading: "Space Grotesk",
    id: "grotesk",
    label: "Space Grotesk",
    note: "Quirky geometric",
  },
  {
    heading: "IBM Plex Sans",
    id: "plex",
    label: "IBM Plex",
    note: "Engineered",
  },
  {
    heading: "Fraunces",
    id: "editorial",
    label: "Editorial",
    note: "Serif headlines",
  },
  {
    heading: "JetBrains Mono",
    id: "terminal",
    label: "Terminal",
    note: "Monospace everything",
  },
] as const;
export type FontId = (typeof FONT_OPTIONS)[number]["id"];

export const RADIUS_OPTIONS = [
  { id: "sharp", label: "Sharp", value: "0.25rem" },
  { id: "soft", label: "Soft", value: "0.625rem" },
  { id: "round", label: "Round", value: "1rem" },
] as const;
export type RadiusId = (typeof RADIUS_OPTIONS)[number]["id"];

export const DENSITY_OPTIONS = [
  { id: "compact", label: "Compact" },
  { id: "default", label: "Default" },
  { id: "comfortable", label: "Roomy" },
] as const;
export type DensityId = (typeof DENSITY_OPTIONS)[number]["id"];

export const BACKDROP_OPTIONS = [
  { id: "aurora", label: "Aurora" },
  { id: "grid", label: "Grid" },
  { id: "dots", label: "Dots" },
  { id: "none", label: "Plain" },
] as const;
export type BackdropId = (typeof BACKDROP_OPTIONS)[number]["id"];

const optionIds = <T extends string>(
  options: readonly { id: T }[]
): [T, ...T[]] => {
  const [first, ...rest] = options.map((option) => option.id);
  if (first === undefined) {
    throw new Error("Appearance option lists must not be empty");
  }
  return [first, ...rest];
};

const MAX_HUE = 360;
const MAX_DISPLAY_NAME_LENGTH = 48;

export const appearanceSchema = z.object({
  accent: z.enum([...optionIds(ACCENT_PRESETS), "custom"]),
  backdrop: z.enum(optionIds(BACKDROP_OPTIONS)),
  customHue: z.number().min(0).max(MAX_HUE),
  density: z.enum(optionIds(DENSITY_OPTIONS)),
  displayName: z.string().max(MAX_DISPLAY_NAME_LENGTH),
  font: z.enum(optionIds(FONT_OPTIONS)),
  mode: z.enum(MODE_OPTIONS),
  radius: z.enum(optionIds(RADIUS_OPTIONS)),
  surface: z.enum(optionIds(SURFACE_OPTIONS)),
});
export type Appearance = z.infer<typeof appearanceSchema>;

export const DEFAULT_APPEARANCE: Appearance = {
  accent: "ember",
  backdrop: "aurora",
  customHue: 200,
  density: "default",
  displayName: "",
  font: "geist",
  mode: "system",
  radius: "soft",
  surface: "stone",
};

export const accentColor = (
  appearance: Pick<Appearance, "accent" | "customHue">
): { chroma: number; hue: number } => {
  const preset = ACCENT_PRESETS.find(
    (candidate) => candidate.id === appearance.accent
  );
  return preset
    ? { chroma: preset.chroma, hue: preset.hue }
    : { chroma: CUSTOM_ACCENT_CHROMA, hue: appearance.customHue };
};

const readStorage = (key: string): string | null => {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
};

export const writeStorage = (key: string, value: string): void => {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Storage can be unavailable (private windows, blocked site data); the
    // appearance still applies for this visit.
  }
};

const storedAppearanceSchema = appearanceSchema.partial();

export const parseAppearance = (
  raw: string | null,
  legacyMode: string | null = null
): Appearance => {
  if (raw) {
    try {
      const stored = storedAppearanceSchema.safeParse(JSON.parse(raw));
      return stored.success
        ? { ...DEFAULT_APPEARANCE, ...stored.data }
        : DEFAULT_APPEARANCE;
    } catch {
      return DEFAULT_APPEARANCE;
    }
  }
  // Earlier releases stored only the colour mode under its own key.
  const mode = z.enum(MODE_OPTIONS).safeParse(legacyMode);
  return mode.success
    ? { ...DEFAULT_APPEARANCE, mode: mode.data }
    : DEFAULT_APPEARANCE;
};

export const loadAppearance = (): Appearance =>
  parseAppearance(
    readStorage(APPEARANCE_STORAGE_KEY),
    readStorage(LEGACY_THEME_STORAGE_KEY)
  );

export const systemMode = (): ResolvedMode =>
  window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";

export const resolveMode = (mode: AppearanceMode): ResolvedMode =>
  mode === "system" ? systemMode() : mode;

interface RootState {
  attributes: Record<string, string>;
  mode: AppearanceMode;
  properties: Record<string, string>;
}

export const rootState = (appearance: Appearance): RootState => {
  const accent = accentColor(appearance);
  const radius =
    RADIUS_OPTIONS.find((option) => option.id === appearance.radius)?.value ??
    "0.625rem";
  return {
    attributes: {
      "data-backdrop": appearance.backdrop,
      "data-density": appearance.density,
      "data-font": appearance.font,
      "data-surface": appearance.surface,
    },
    mode: appearance.mode,
    properties: {
      "--accent-c": accent.chroma.toString(),
      "--accent-h": accent.hue.toString(),
      "--radius": radius,
    },
  };
};

export const applyAppearance = (appearance: Appearance): ResolvedMode => {
  const root = document.documentElement;
  const state = rootState(appearance);
  const resolved = resolveMode(appearance.mode);
  for (const [name, value] of Object.entries(state.attributes)) {
    root.setAttribute(name, value);
  }
  for (const [name, value] of Object.entries(state.properties)) {
    root.style.setProperty(name, value);
  }
  root.classList.toggle("dark", resolved === "dark");
  root.classList.toggle("light", resolved === "light");
  return resolved;
};

export const persistAppearance = (appearance: Appearance): void => {
  writeStorage(APPEARANCE_STORAGE_KEY, JSON.stringify(appearance));
  writeStorage(
    APPEARANCE_BOOT_STORAGE_KEY,
    JSON.stringify(rootState(appearance))
  );
  writeStorage(LEGACY_THEME_STORAGE_KEY, appearance.mode);
};

export const greeting = (date: Date, name: string): string => {
  const hour = date.getHours();
  let salutation = "Good evening";
  if (hour < 5) {
    salutation = "Burning the midnight oil";
  } else if (hour < 12) {
    salutation = "Good morning";
  } else if (hour < 18) {
    salutation = "Good afternoon";
  }
  const trimmed = name.trim();
  return trimmed ? `${salutation}, ${trimmed}` : salutation;
};
