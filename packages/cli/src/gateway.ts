import { runCli } from "./cli";
import { runDashboardAuthCommand } from "./dashboard-auth";

export const runGatewayCli = async (): Promise<void> => {
  const [command, ...args] = process.argv.slice(2);
  if (command === "auth") {
    await runDashboardAuthCommand(args);
    return;
  }
  await runCli("gateway");
};
