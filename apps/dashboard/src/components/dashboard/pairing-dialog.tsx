import type { FormEvent } from "react";
import { useState } from "react";

import { errorResponseSchema } from "@/lib/schemas";

export const PairingDialog = () => {
  const [pairingCode, setPairingCode] = useState("");
  const [deviceName, setDeviceName] = useState(
    `${navigator.platform || "Browser"} dashboard`
  );
  const [pairingError, setPairingError] = useState("");
  const [pairing, setPairing] = useState(false);

  const submitPairingCode = async (
    event: FormEvent<HTMLFormElement>
  ): Promise<void> => {
    event.preventDefault();
    setPairing(true);
    setPairingError("");
    try {
      const response = await fetch("/api/v1/auth/pair", {
        body: JSON.stringify({ code: pairingCode, deviceName }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      if (!response.ok) {
        const body = errorResponseSchema.safeParse(
          await response.json().catch(() => null)
        );
        setPairingError(
          body.success ? body.data.error : "Could not pair this device."
        );
        return;
      }
      window.location.reload();
    } catch {
      setPairingError("Could not reach the gateway.");
    } finally {
      setPairing(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-background/90 p-4 backdrop-blur">
      <form
        className="w-full max-w-sm space-y-4 rounded-lg border bg-card p-6 shadow-xl"
        onSubmit={submitPairingCode}
      >
        <div>
          <h1 className="text-lg font-semibold">Pair this device</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Run <code>toktracker-gateway auth code</code> on the gateway, then
            enter the one-time code below.
          </p>
        </div>
        <label className="block space-y-1 text-sm font-medium">
          <span>Device name</span>
          <input
            autoComplete="name"
            className="h-10 w-full rounded-md border bg-background px-3"
            maxLength={128}
            onChange={(event) => setDeviceName(event.target.value)}
            required
            value={deviceName}
          />
        </label>
        <label className="block space-y-1 text-sm font-medium">
          <span>Pairing code</span>
          <input
            autoCapitalize="characters"
            autoComplete="one-time-code"
            className="h-10 w-full rounded-md border bg-background px-3 font-mono uppercase tracking-wider"
            maxLength={64}
            onChange={(event) => setPairingCode(event.target.value)}
            placeholder="XXXX-XXXX-XXXX-XXXX"
            required
            value={pairingCode}
          />
        </label>
        {pairingError && (
          <p className="text-sm text-destructive">{pairingError}</p>
        )}
        <button
          className="h-10 w-full rounded-md bg-primary px-4 font-medium text-primary-foreground disabled:opacity-50"
          disabled={pairing}
          type="submit"
        >
          {pairing ? "Pairing…" : "Pair device"}
        </button>
      </form>
    </div>
  );
};
