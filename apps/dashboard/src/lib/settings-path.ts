const SETTINGS_SECTIONS = [
  "general",
  "devices",
  "export",
  "providers",
  "cursor",
  "copilot",
] as const;

export type SettingsPathSection = (typeof SETTINGS_SECTIONS)[number];

interface ParsedSettingsPath {
  isSettingsPath: boolean;
  section: SettingsPathSection | undefined;
  settingsOpen: boolean;
}

export const parseSettingsPath = (pathname: string): ParsedSettingsPath => {
  const [root, parent, child] = pathname.split("/").filter(Boolean);
  const isSettingsPath = root === "settings";
  const section = parent === "providers" && child ? child : parent;
  const settingsSection = SETTINGS_SECTIONS.find((value) => value === section);
  return {
    isSettingsPath,
    section: isSettingsPath ? settingsSection : undefined,
    settingsOpen:
      isSettingsPath && (section === undefined || Boolean(settingsSection)),
  };
};
