// Applies the saved TokTracker appearance before the app bundle loads so the
// first paint uses the right colours. The dashboard writes this snapshot
// whenever appearance settings change (see src/lib/appearance.ts).
(() => {
  try {
    const snapshot = JSON.parse(
      window.localStorage.getItem("toktracker-appearance-boot") ?? "null"
    );
    const root = document.documentElement;
    const mode = snapshot?.mode ?? "system";
    const dark =
      mode === "dark" ||
      (mode === "system" &&
        window.matchMedia("(prefers-color-scheme: dark)").matches);
    root.classList.add(dark ? "dark" : "light");
    for (const [name, value] of Object.entries(snapshot?.attributes ?? {})) {
      root.setAttribute(name, String(value));
    }
    for (const [name, value] of Object.entries(snapshot?.properties ?? {})) {
      root.style.setProperty(name, String(value));
    }
  } catch {
    // Fall back to the stylesheet defaults.
  }
})();
