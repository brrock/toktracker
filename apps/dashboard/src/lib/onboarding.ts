import { writeStorage } from "@/lib/appearance";

const ONBOARDING_STORAGE_KEY = "toktracker-onboarding";
const ONBOARDING_COMPLETE = "complete";
export const ONBOARDING_PATH = "/welcome";

export const isOnboardingComplete = (): boolean => {
  try {
    return (
      window.localStorage.getItem(ONBOARDING_STORAGE_KEY) ===
      ONBOARDING_COMPLETE
    );
  } catch {
    // Without storage the tour would reappear on every visit; skip it.
    return true;
  }
};

export const markOnboardingComplete = (): void =>
  writeStorage(ONBOARDING_STORAGE_KEY, ONBOARDING_COMPLETE);

export const CLIENT_INSTALL_COMMANDS = [
  {
    command:
      "curl -fsSL https://raw.githubusercontent.com/brrock/toktracker/main/install-client.sh | bash",
    id: "unix",
    label: "macOS / Linux",
  },
  {
    command:
      "irm https://raw.githubusercontent.com/brrock/toktracker/main/install-client.ps1 | iex",
    id: "windows",
    label: "Windows",
  },
] as const;
