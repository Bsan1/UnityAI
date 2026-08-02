import { useEffect, useState } from "react";

import type { HealthResponse } from "@unityai/shared";

type ConnectionState =
  | { status: "checking" }
  | { status: "connected"; health: HealthResponse }
  | { status: "unavailable" };

const isHealthResponse = (value: unknown): value is HealthResponse => {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (
    candidate.status === "ok" &&
    typeof candidate.app === "string" &&
    typeof candidate.version === "string" &&
    typeof candidate.milestone === "string"
  );
};

export function App() {
  const [connection, setConnection] = useState<ConnectionState>({
    status: "checking",
  });

  useEffect(() => {
    const controller = new AbortController();

    const checkServer = async () => {
      try {
        const response = await fetch("/health", {
          signal: controller.signal,
        });
        const payload: unknown = await response.json();

        if (!response.ok || !isHealthResponse(payload)) {
          throw new Error("Server returned an invalid health response.");
        }

        setConnection({ status: "connected", health: payload });
      } catch (error: unknown) {
        if (error instanceof DOMException && error.name === "AbortError") {
          return;
        }

        setConnection({ status: "unavailable" });
      }
    };

    void checkServer();

    return () => {
      controller.abort();
    };
  }, []);

  const statusText =
    connection.status === "checking"
      ? "Checking..."
      : connection.status === "connected"
        ? "Connected"
        : "Unavailable";

  return (
    <main>
      <section aria-labelledby="app-title">
        <p className="eyebrow">Local Unity development orchestrator</p>
        <h1 id="app-title">UnityAI</h1>
        <p>
          Server: <strong data-status={connection.status}>{statusText}</strong>
        </p>
        {connection.status === "connected" ? (
          <small>
            {connection.health.milestone} foundation · v
            {connection.health.version}
          </small>
        ) : null}
      </section>
    </main>
  );
}
