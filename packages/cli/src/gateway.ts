import { runCli } from "./cli";
import { readActiveInstallation } from "./installation";
import { updateRole } from "./update";

export const runGatewayCli = (): Promise<void> => runCli("gateway");

/** The installed release version, or undefined for source checkouts. */
export const currentGatewayVersion = async (): Promise<string | undefined> => {
  const active = await readActiveInstallation("gateway");
  return active?.version;
};

/** Updates only versioned release installs; source checkouts remain untouched. */
export const autoUpdateGateway = async (
  channel: "nightly" | "stable"
): Promise<boolean> => {
  if (!(await readActiveInstallation("gateway"))) {
    return false;
  }
  await updateRole("gateway", channel);
  return true;
};
