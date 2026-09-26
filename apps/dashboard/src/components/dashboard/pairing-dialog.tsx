import type { FormEvent } from "react";
import { useState } from "react";

import { errorResponseSchema } from "@/lib/schemas";

import { BrandMark } from "./primitives";

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
    <div className="fixed inset-0 z-50 grid place-items-center bg-background p-4">
      <div className="app-backdrop" />
      <form
        className="surface-card animate-rise relative w-full max-w-sm space-y-5 p-7 shadow-2xl"
        onSubmit={submitPairingCode}
      >
        <div>
          <BrandMark className="size-11 rounded-xl" />
          <h1 className="mt-5 text-xl font-semibold">Pair this browser</h1>
          <p className="mt-1.5 text-sm text-muted-foreground">
            On the gateway machine, run{" "}
            <code className="whitespace-nowrap rounded-md border bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">
              toktracker-gateway auth code
            </code>{" "}
            and enter the one-time code below.
          </p>
        </div>
        <label className="block space-y-1.5 text-sm font-medium">
          <span>Device name</span>
          <input
            autoComplete="off"
            className="h-10 w-full rounded-lg border bg-card px-3 font-normal outline-none transition focus:border-primary focus:ring-3 focus:ring-primary/20"
            maxLength={128}
            onChange={(event) => setDeviceName(event.target.value)}
            required
            value={deviceName}
          />
        </label>
        <label className="block space-y-1.5 text-sm font-medium">
          <span>Pairing code</span>
          <input
            autoCapitalize="characters"
            autoComplete="one-time-code"
            className="h-11 w-full rounded-lg border bg-card px-3 text-center font-mono text-base uppercase tracking-[0.2em] outline-none transition focus:border-primary focus:ring-3 focus:ring-primary/20"
            maxLength={64}
            onChange={(event) => setPairingCode(event.target.value)}
            placeholder="XXXX-XXXX-XXXX-XXXX"
            required
            value={pairingCode}
          />
        </label>
        {pairingError && (
          <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {pairingError}
          </p>
        )}
        <button
          className="brand-gradient h-10 w-full rounded-lg px-4 font-medium text-primary-foreground shadow-[0_8px_24px_-10px_var(--primary)] transition hover:brightness-110 disabled:opacity-50"
          disabled={pairing}
          type="submit"
        >
          {pairing ? "Pairing…" : "Pair and continue"}
        </button>
      </form>
    </div>
  );
};
