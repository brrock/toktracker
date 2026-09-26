/* eslint-disable react-refresh/only-export-components */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

import {
  APPEARANCE_STORAGE_KEY,
  applyAppearance,
  DEFAULT_APPEARANCE,
  loadAppearance,
  parseAppearance,
  persistAppearance,
  resolveMode,
} from "@/lib/appearance";
import type {
  Appearance,
  AppearanceMode,
  ResolvedMode,
} from "@/lib/appearance";

const COLOR_SCHEME_QUERY = "(prefers-color-scheme: dark)";
const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

interface AppearanceState {
  appearance: Appearance;
  resetAppearance: () => void;
  resolvedMode: ResolvedMode;
  setMode: (mode: AppearanceMode) => void;
  updateAppearance: (changes: Partial<Appearance>) => void;
}

const AppearanceContext = createContext<AppearanceState | undefined>(undefined);

const disableTransitionsTemporarily = (): (() => void) => {
  const style = document.createElement("style");
  style.append(
    document.createTextNode(
      "*,*::before,*::after{-webkit-transition:none!important;transition:none!important}"
    )
  );
  document.head.append(style);
  return () => {
    window.getComputedStyle(document.body);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        style.remove();
      });
    });
  };
};

const isEditableTarget = (target: EventTarget | null): boolean => {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  return (
    target.isContentEditable ||
    Boolean(target.closest("input, textarea, select, [contenteditable='true']"))
  );
};

const withViewTransition = (update: () => void): void => {
  const prefersReducedMotion = window.matchMedia(REDUCED_MOTION_QUERY).matches;
  if (!document.startViewTransition || prefersReducedMotion) {
    update();
    return;
  }
  document.startViewTransition(update);
};

export const ThemeProvider = ({ children }: { children: React.ReactNode }) => {
  const [appearance, setAppearance] = useState<Appearance>(loadAppearance);
  const [systemDark, setSystemDark] = useState(
    () => window.matchMedia(COLOR_SCHEME_QUERY).matches
  );
  const systemResolved: ResolvedMode = systemDark ? "dark" : "light";
  const resolvedMode =
    appearance.mode === "system" ? systemResolved : appearance.mode;

  useEffect(() => {
    const restoreTransitions = disableTransitionsTemporarily();
    applyAppearance(appearance);
    restoreTransitions();
    persistAppearance(appearance);
  }, [appearance, systemDark]);

  useEffect(() => {
    const mediaQuery = window.matchMedia(COLOR_SCHEME_QUERY);
    const handleChange = (): void => setSystemDark(mediaQuery.matches);
    mediaQuery.addEventListener("change", handleChange);
    return () => mediaQuery.removeEventListener("change", handleChange);
  }, []);

  // Keep other tabs of the dashboard in sync.
  useEffect(() => {
    const handleStorageChange = (event: StorageEvent): void => {
      if (event.key === APPEARANCE_STORAGE_KEY) {
        setAppearance(parseAppearance(event.newValue));
      }
    };
    window.addEventListener("storage", handleStorageChange);
    return () => window.removeEventListener("storage", handleStorageChange);
  }, []);

  const updateAppearance = useCallback((changes: Partial<Appearance>): void => {
    setAppearance((current) => ({ ...current, ...changes }));
  }, []);

  const setMode = useCallback(
    (mode: AppearanceMode): void => {
      const changesColors = resolveMode(mode) !== resolvedMode;
      const update = (): void => {
        const next = { ...appearance, mode };
        applyAppearance(next);
        setAppearance(next);
      };
      if (changesColors) {
        withViewTransition(update);
      } else {
        update();
      }
    },
    [appearance, resolvedMode]
  );

  const resetAppearance = useCallback((): void => {
    setAppearance((current) => ({
      ...DEFAULT_APPEARANCE,
      displayName: current.displayName,
    }));
  }, []);

  // Press "d" anywhere outside a text field to flip between light and dark.
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      const isShortcut =
        !event.repeat &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        event.key.toLowerCase() === "d" &&
        !isEditableTarget(event.target);
      if (isShortcut) {
        setMode(resolvedMode === "dark" ? "light" : "dark");
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [resolvedMode, setMode]);

  const value = useMemo(
    () => ({
      appearance,
      resetAppearance,
      resolvedMode,
      setMode,
      updateAppearance,
    }),
    [appearance, resetAppearance, resolvedMode, setMode, updateAppearance]
  );

  return (
    <AppearanceContext.Provider value={value}>
      {children}
    </AppearanceContext.Provider>
  );
};

export const useAppearance = (): AppearanceState => {
  const context = useContext(AppearanceContext);
  if (context === undefined) {
    throw new Error("useAppearance must be used within a ThemeProvider");
  }
  return context;
};
