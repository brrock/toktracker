import type { DashboardSummary } from "@toktracker/shared";
import { useCallback, useEffect, useState } from "react";
import { z } from "zod";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { apiFetch } from "@/lib/api";
import {
  clientUpdateReleaseSchema,
  clientUpdateRequestSchema,
} from "@/lib/schemas";

type UpdateChannel = "nightly" | "stable";
type UpdateRelease = z.infer<typeof clientUpdateReleaseSchema>;
type UpdateRequest = NonNullable<z.infer<typeof clientUpdateRequestSchema>>;

const REQUEST_POLL_MS = 5000;

const errorBodySchema = z.object({ error: z.string() });

const resultLabel = (request: UpdateRequest, deviceId: string) => {
  const result = request.results[deviceId];
  if (!result) {
    return { detail: undefined, text: "Waiting for device to check in" };
  }
  return result.status === "updated"
    ? { detail: undefined, text: "Updated" }
    : { detail: result.error, text: "Failed" };
};

export const ClientUpdatePanel = ({
  channel,
  devices,
}: {
  channel: UpdateChannel;
  devices: DashboardSummary["devices"];
}) => {
  const [release, setRelease] = useState<UpdateRelease>();
  const [request, setRequest] = useState<UpdateRequest>();
  const [selectedIds, setSelectedIds] = useState<string[]>(() =>
    devices.map((device) => device.id)
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const loadRequest = useCallback(async (): Promise<void> => {
    try {
      const response = await apiFetch("/api/v1/settings/client-update-request");
      if (response.ok) {
        setRequest(
          clientUpdateRequestSchema.parse(await response.json()) ?? undefined
        );
      }
    } catch {
      // The panel keeps showing the last known request.
    }
  }, []);

  const requestInProgress = Boolean(
    request && request.deviceIds.some((deviceId) => !request.results[deviceId])
  );

  useEffect(() => {
    void loadRequest();
  }, [loadRequest]);

  useEffect(() => {
    if (!requestInProgress) {
      return;
    }
    const timer = setInterval(() => {
      void loadRequest();
    }, REQUEST_POLL_MS);
    return () => clearInterval(timer);
  }, [loadRequest, requestInProgress]);

  const checkRelease = async (): Promise<void> => {
    setBusy(true);
    setError("");
    try {
      const response = await apiFetch(
        `/api/v1/settings/client-update-release?channel=${channel}`
      );
      if (!response.ok) {
        const body = errorBodySchema.safeParse(
          await response.json().catch(() => null)
        );
        setError(
          body.success
            ? body.data.error
            : "Could not look up the latest release"
        );
        return;
      }
      setRelease(clientUpdateReleaseSchema.parse(await response.json()));
    } catch {
      setError("Could not look up the latest release");
    } finally {
      setBusy(false);
    }
  };

  const sendUpdate = async (): Promise<void> => {
    setBusy(true);
    setError("");
    try {
      const response = await apiFetch(
        "/api/v1/settings/client-update-request",
        {
          body: JSON.stringify({ channel, deviceIds: selectedIds }),
          headers: { "content-type": "application/json" },
          method: "POST",
        }
      );
      if (!response.ok) {
        setError("Could not start the update");
        return;
      }
      setRequest(
        clientUpdateRequestSchema.parse(await response.json()) ?? undefined
      );
      setRelease(undefined);
    } catch {
      setError("Could not start the update");
    } finally {
      setBusy(false);
    }
  };

  const toggle = (id: string, checked: boolean): void =>
    setSelectedIds((current) =>
      checked
        ? [...current, id]
        : current.filter((selectedId) => selectedId !== id)
    );

  const deviceName = (id: string): string =>
    devices.find((device) => device.id === id)?.name ?? id;

  return (
    <div className="mt-6 surface-card p-5">
      <h3 className="font-medium">Update clients now</h3>
      <p className="mt-1 text-sm text-muted-foreground">
        Skip the maintenance window and ask selected devices to install the
        latest {channel} release. Devices pick this up the next time they check
        in, which is within about a minute while they are running.
      </p>

      {release ? (
        <div className="mt-4 space-y-4">
          <div>
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
            <pre className="mt-2 max-h-64 overflow-auto rounded-md bg-muted p-3 text-xs whitespace-pre-wrap">
              {release.changelog || "No changelog was published."}
            </pre>
          </div>
          <fieldset className="space-y-1">
            <legend className="text-sm font-medium">Devices to update</legend>
            {devices.map((device) => (
              <label
                key={device.id}
                htmlFor={`update-device-${device.id}`}
                className="flex cursor-pointer items-center gap-3 rounded-md p-2 hover:bg-muted"
              >
                <Checkbox
                  id={`update-device-${device.id}`}
                  checked={selectedIds.includes(device.id)}
                  onCheckedChange={(checked) => toggle(device.id, checked)}
                />
                <span className="text-sm">
                  {device.name}
                  <span className="text-muted-foreground">
                    {" "}
                    · {device.platform}
                  </span>
                </span>
              </label>
            ))}
          </fieldset>
          <div className="flex gap-2">
            <Button
              disabled={busy || selectedIds.length === 0}
              size="sm"
              onClick={sendUpdate}
            >
              {busy
                ? "Sending…"
                : `Update ${selectedIds.length} ${selectedIds.length === 1 ? "device" : "devices"} to ${release.version}`}
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
          disabled={busy || devices.length === 0}
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

      {request && (
        <div className="mt-6 space-y-2">
          <h4 className="text-sm font-medium">
            Last request: {request.version} (
            {new Date(request.createdAt).toLocaleString()})
          </h4>
          <ul className="space-y-1 text-sm">
            {request.deviceIds.map((deviceId) => {
              const { detail, text } = resultLabel(request, deviceId);
              return (
                <li key={deviceId} className="flex flex-wrap gap-x-2">
                  <span>{deviceName(deviceId)}</span>
                  <span className="text-muted-foreground">
                    {text}
                    {detail ? `: ${detail}` : ""}
                  </span>
                </li>
              );
            })}
          </ul>
          <details className="text-sm">
            <summary className="cursor-pointer text-muted-foreground">
              Changelog for this request
            </summary>
            <pre className="mt-2 max-h-64 overflow-auto rounded-md bg-muted p-3 text-xs whitespace-pre-wrap">
              {request.changelog || "No changelog was published."}
            </pre>
          </details>
        </div>
      )}
    </div>
  );
};
