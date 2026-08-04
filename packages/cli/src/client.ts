import { runCli } from "./cli";
import { readActiveInstallation } from "./installation";
import { updateRole } from "./update";

export const runClientCli = (): Promise<void> => runCli("client");

/** Updates only versioned release installs; source checkouts remain untouched. */
export const autoUpdateClient = async (
  channel: "nightly" | "stable"
): Promise<boolean> => {
  if (!(await readActiveInstallation("client"))) {
    return false;
  }
  await updateRole("client", channel);
  return true;
};
