const SETTINGS_SECTIONS = ["general", "devices", "export", "cursor"] as const;

export type SettingsPathSection = (typeof SETTINGS_SECTIONS)[number];

interface ParsedSettingsPath {
  isSettingsPath: boolean;
  section: SettingsPathSection | undefined;
  settingsOpen: boolean;
}

export const parseSettingsPath = (pathname: string): ParsedSettingsPath => {
  const [root, section] = pathname.split("/").filter(Boolean);
  const isSettingsPath = root === "settings";
  const settingsSection = SETTINGS_SECTIONS.find((value) => value === section);
  return {
    isSettingsPath,
    section: settingsSection,
    settingsOpen:
      isSettingsPath && (section === undefined || Boolean(settingsSection)),
  };
};
