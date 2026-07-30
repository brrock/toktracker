export const AUTH_REQUIRED_EVENT = "toktracker-auth-required";

let refreshRequest: Promise<boolean> | undefined;

const refreshDashboardSession = (): Promise<boolean> => {
  refreshRequest ??= (async () => {
    try {
      const response = await fetch("/api/v1/auth/refresh", { method: "POST" });
      return response.ok;
    } catch {
      return false;
    } finally {
      refreshRequest = undefined;
    }
  })();
  return refreshRequest;
};

export const apiFetch = async (
  input: RequestInfo | URL,
  init: RequestInit = {}
): Promise<Response> => {
  const response = await fetch(input, init);
  if (response.status !== 401) {
    return response;
  }
  if (await refreshDashboardSession()) {
    const retriedResponse = await fetch(input, init);
    if (retriedResponse.status !== 401) {
      return retriedResponse;
    }
  }
  window.dispatchEvent(new Event(AUTH_REQUIRED_EVENT));
  return response;
};
