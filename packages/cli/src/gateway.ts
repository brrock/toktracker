import { runCli } from "./cli";
import { runDashboardAuthCommand } from "./dashboard-auth";

export const runGatewayCli = async (): Promise<void> => {
  const [command, ...args] = process.argv.slice(2);
  if (command === "auth") {
    if (args.includes("--help") || args.includes("-h")) {
      console.log(
        "Usage: toktracker-gateway auth [code|devices|revoke <device-id>]"
      );
      return;
    }
    await runDashboardAuthCommand(args);
    return;
  }
  await runCli("gateway");
};
