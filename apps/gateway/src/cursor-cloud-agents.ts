import {
  fetchCloudAgents,
  makeMessage,
  normalizeWorkspace,
} from "@toktracker/token-calc";

import type { CloudAgentAccount, Store } from "./store";

const CLOUD_AGENT_DEVICE_ID = "cursor-cloud-agents";

export const syncCloudAgentAccount = async (
  store: Store,
  account: CloudAgentAccount
): Promise<number> => {
  const agents = await fetchCloudAgents(account.apiKey);
  const now = Date.now();
  const sourcePath = `cursor-cloud-agent:${account.id}`;
  const sessions = agents.map((agent) => {
    const workspace = agent.repository
      ? normalizeWorkspace(agent.repository)
      : undefined;
    const timestamp = agent.updatedAt ?? now;
    return {
      deviceId: CLOUD_AGENT_DEVICE_ID,
      messages: [
        makeMessage({
          client: "cursor-cloud",
          cost: 0,
          costSource: "unknown",
          dedupKey: `cursor-cloud:${account.id}:${agent.id}`,
          modelId: "cursor-cloud-agent",
          providerId: "cursor",
          sessionId: `cursor-cloud-${account.id}-${agent.id}`,
          sessionTitle: agent.name,
          timestamp,
          tokens: {
            cacheRead: 0,
            cacheWrite: 0,
            input: 0,
            output: 0,
            reasoning: 0,
          },
          workspaceKey: workspace?.key,
          workspaceLabel: workspace?.label,
        }),
      ],
      project: workspace?.label,
      sessionId: `cursor-cloud-${account.id}-${agent.id}`,
      sourceMtimeMs: now,
      sourcePath,
      sourceSize: agents.length,
    };
  });
  store.ingest({
    device: {
      id: CLOUD_AGENT_DEVICE_ID,
      name: "Cursor Cloud Agents",
      platform: "cloud",
    },
    sessions,
    sourceUpdates: [{ mode: "replace", sourcePath }],
  });
  return agents.length;
};
