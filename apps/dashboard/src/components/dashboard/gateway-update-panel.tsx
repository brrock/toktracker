import { useCallback, useEffect, useState } from "react";
import { z } from "zod";

import { Button } from "@/components/ui/button";
import { apiFetch } from "@/lib/api";
import {
  clientUpdateReleaseSchema,
  gatewayUpdateInfoSchema,
} from "@/lib/schemas";

type GatewayUpdateInfo = z.infer<typeof gatewayUpdateInfoSchema>;
type UpdateRelease = z.infer<typeof clientUpdateReleaseSchema>;

const STATUS_POLL_MS = 3000;
const errorBodySchema = z.object({ error: z.string() });

const statusText = (status: NonNullable<GatewayUpdateInfo["status"]>) => {
  if (status.state === "running") {
    return `Updating to ${status.targetVersion}. The dashboard may disconnect briefly while the gateway restarts.`;
  }
  const outcome =
    status.state === "updated" ? "Updated to" : "Failed to update to";
  return `${outcome} ${status.targetVersion}${status.message ? `: ${status.message}` : ""}`;
};

const readError = async (
  response: Response,
  fallback: string
): Promise<string> => {
  const body = errorBodySchema.safeParse(
    await response.json().catch(() => null)
  );
  return body.success ? body.data.error : fallback;
};

export const GatewayUpdatePanel = ({
  channel,
}: {
  channel: "nightly" | "stable";
}) => {
  const [info, setInfo] = useState<GatewayUpdateInfo>();
  const [release, setRelease] = useState<UpdateRelease>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const loadInfo = useCallback(async (): Promise<void> => {
    try {
      const response = await apiFetch("/api/v1/settings/gateway-update");
      if (response.ok) {
        setInfo(gatewayUpdateInfoSchema.parse(await response.json()));
      }
    } catch {
      // The gateway is unreachable while it restarts; keep polling.
    }
  }, []);

  const running = info?.status?.state === "running";

  useEffect(() => {
    void loadInfo();
  }, [loadInfo]);

  useEffect(() => {
    if (!running) {
      return;
    }
    const timer = setInterval(() => {
      void loadInfo();
    }, STATUS_POLL_MS);
    return () => clearInterval(timer);
  }, [loadInfo, running]);

  const checkRelease = async (): Promise<void> => {
    setBusy(true);
    setError("");
    try {
      const response = await apiFetch(
        `/api/v1/settings/client-update-release?channel=${channel}`
      );
      if (response.ok) {
        setRelease(clientUpdateReleaseSchema.parse(await response.json()));
      } else {
        setError(
          await readError(response, "Could not look up the latest release")
        );
      }
    } catch {
      setError("Could not look up the latest release");
    } finally {
      setBusy(false);
    }
  };

  const startUpdate = async (): Promise<void> => {
    setBusy(true);
    setError("");
    try {
      const response = await apiFetch("/api/v1/settings/gateway-update", {
        body: JSON.stringify({ channel }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      if (response.ok) {
        setRelease(undefined);
        await loadInfo();
      } else {
        setError(await readError(response, "Could not start the update"));
      }
    } catch {
      setError("Could not start the update");
    } finally {
      setBusy(false);
    }
  };

  if (info && !info.available) {
    return null;
  }

  return (
    <div className="mt-6 surface-card p-5">
      <h3 className="font-medium">Update gateway</h3>
      <p className="mt-1 text-sm text-muted-foreground">
        Install the latest {channel} release on this gateway and restart it.
        Update the gateway before updating clients.
        {info?.currentVersion && ` Currently running ${info.currentVersion}.`}
      </p>

      {release ? (
        <div className="mt-4 space-y-3">
          <p className="text-sm font-medium">
            Release {release.version}
            {release.releaseUrl && (
              <>
                {" · "}
                <a
                  className="text-primary underline"
                  href={release.releaseUrl}
                  rel="noopener noreferrer"
                  target="_blank"
                >
                  View on GitHub
                </a>
              </>
            )}
          </p>
          <pre className="max-h-64 overflow-auto rounded-md bg-muted p-3 text-xs whitespace-pre-wrap">
            {release.changelog || "No changelog was published."}
          </pre>
          <div className="flex gap-2">
            <Button disabled={busy} size="sm" onClick={startUpdate}>
              {busy ? "Starting…" : `Update gateway to ${release.version}`}
            </Button>
            <Button
              disabled={busy}
              size="sm"
              variant="outline"
              onClick={() => setRelease(undefined)}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <Button
          className="mt-4"
          disabled={busy || running}
          size="sm"
          onClick={checkRelease}
        >
          {busy ? "Checking…" : "Review latest release"}
        </Button>
      )}

      {error && (
        <p className="mt-3 text-sm text-destructive" role="alert">
          {error}
        </p>
      )}
      {info?.status && (
        <output className="mt-3 block text-sm text-muted-foreground">
          {statusText(info.status)}
        </output>
      )}
    </div>
  );
};
