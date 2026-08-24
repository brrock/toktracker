import type { SessionSort, TimeRange } from "@toktracker/shared";
import { ArrowLeft, Search, Settings, Zap } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Navigate,
  Route,
  Routes,
  useLocation,
  useNavigate,
  useSearchParams,
} from "react-router-dom";

import { CommandPalette } from "@/components/dashboard/command-palette";
import { DeviceFilter, ThemeControl } from "@/components/dashboard/filters";
import { Navigation } from "@/components/dashboard/navigation";
import { PairingDialog } from "@/components/dashboard/pairing-dialog";
import { EmptyState } from "@/components/dashboard/primitives";
import {
  SettingsNavigation,
  SettingsPage,
} from "@/components/dashboard/settings";
import { AUTH_REQUIRED_EVENT, apiFetch } from "@/lib/api";
import { EMPTY_SUMMARY } from "@/lib/dashboard";
import { Link, NAV_ITEMS } from "@/lib/navigation";
import { dashboardSummarySchema, timeRangeSchema } from "@/lib/schemas";
import { parseSettingsPath } from "@/lib/settings-path";
import { AgentPage, AgentsPage } from "@/pages/agents-page";
import { ModelPage } from "@/pages/model-page";
import { OverviewPage } from "@/pages/overview-page";
import { ProjectPage, ProjectsPage } from "@/pages/projects-page";
import { SessionPage, SessionsPage } from "@/pages/sessions-page";

const SESSION_SORT_STORAGE_KEY = "toktracker-session-sort";

const App = () => {
  const [data, setData] = useState(EMPTY_SUMMARY);
  const [sessionSort, setSessionSort] = useState<SessionSort>(() =>
    window.localStorage.getItem(SESSION_SORT_STORAGE_KEY) === "createdAt"
      ? "createdAt"
      : "lastSeen"
  );
  const [overviewData, setOverviewData] = useState(EMPTY_SUMMARY);
  const [loading, setLoading] = useState(true);
  const [searchOpen, setSearchOpen] = useState(false);
  const [authRequired, setAuthRequired] = useState(false);
  const [searchParams, setSearchParams] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const {
    isSettingsPath,
    section: settingsSection,
    settingsOpen,
  } = parseSettingsPath(location.pathname);
  const requestedRange = searchParams.get("range");
  const parsedRange = timeRangeSchema.safeParse(requestedRange);
  const range: TimeRange = parsedRange.success ? parsedRange.data : "month";
  const selectedDeviceIds = (searchParams.get("devices") ?? "")
    .split(",")
    .filter(Boolean);
  const deviceParam = selectedDeviceIds.join(",");
  const updateSearchParam = useCallback(
    (key: string, value?: string): void => {
      setSearchParams((current) => {
        const updated = new URLSearchParams(current);
        if (value) {
          updated.set(key, value);
        } else {
          updated.delete(key);
        }
        return updated;
      });
    },
    [setSearchParams]
  );

  useEffect(() => {
    window.localStorage.setItem(SESSION_SORT_STORAGE_KEY, sessionSort);
  }, [sessionSort]);

  useEffect(() => {
    const requireAuthentication = (): void => setAuthRequired(true);
    window.addEventListener(AUTH_REQUIRED_EVENT, requireAuthentication);
    return () =>
      window.removeEventListener(AUTH_REQUIRED_EVENT, requireAuthentication);
  }, []);

  useEffect(() => {
    if (location.pathname === "/" && requestedRange !== range) {
      updateSearchParam("range", range);
      return;
    }
    if (location.pathname !== "/" && requestedRange) {
      updateSearchParam("range");
    }
  }, [location.pathname, range, requestedRange, updateSearchParam]);

  useEffect(() => {
    const controller = new AbortController();
    const loadSummary = async (): Promise<void> => {
      try {
        const overviewRequest = new URLSearchParams({ range });
        const globalRequest = new URLSearchParams({
          includeAllDevices: "true",
          range: "all",
          sessionSort,
        });
        overviewRequest.set("sessionSort", sessionSort);
        if (deviceParam) {
          overviewRequest.set("devices", deviceParam);
          globalRequest.set("devices", deviceParam);
        }
        const [overviewResponse, globalResponse] = await Promise.all([
          apiFetch(`/api/v1/summary?${overviewRequest}`, {
            signal: controller.signal,
          }),
          apiFetch(`/api/v1/summary?${globalRequest}`, {
            signal: controller.signal,
          }),
        ]);
        if (!overviewResponse.ok || !globalResponse.ok) {
          throw new Error("Summary request failed");
        }
        const [overviewSummary, globalSummary] = await Promise.all([
          overviewResponse
            .json()
            .then((body) => dashboardSummarySchema.parse(body)),
          globalResponse
            .json()
            .then((body) => dashboardSummarySchema.parse(body)),
        ]);
        setOverviewData(overviewSummary);
        setData(globalSummary);
      } catch {
        if (!controller.signal.aborted) {
          setData(EMPTY_SUMMARY);
          setOverviewData(EMPTY_SUMMARY);
        }
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false);
        }
      }
    };
    loadSummary();
    return () => controller.abort();
  }, [deviceParam, range, sessionSort]);

  useEffect(() => {
    const openSearch = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setSearchOpen((current) => !current);
      }
    };
    window.addEventListener("keydown", openSearch);
    return () => window.removeEventListener("keydown", openSearch);
  }, []);

  const pageTitle = useMemo(() => {
    const navigationTitle = NAV_ITEMS.find(
      (item) => item.to === location.pathname
    )?.label;
    if (navigationTitle) {
      return navigationTitle;
    }
    if (location.pathname.startsWith("/agents/")) {
      return "Agent details";
    }
    if (location.pathname.startsWith("/projects/")) {
      return "Project details";
    }
    if (location.pathname.startsWith("/models/")) {
      return "Model details";
    }
    if (location.pathname.startsWith("/sessions/")) {
      return "Session details";
    }
    return "TokTracker";
  }, [location.pathname]);

  useEffect(() => {
    document.title =
      pageTitle === "TokTracker" ? pageTitle : `${pageTitle} | TokTracker`;
  }, [pageTitle]);

  let mainContent: React.ReactNode;
  if (loading) {
    mainContent = <EmptyState>Loading usage…</EmptyState>;
  } else if (isSettingsPath && settingsSection === undefined) {
    mainContent = <Navigate replace to="/settings/general" />;
  } else if (settingsOpen) {
    mainContent = (
      <SettingsPage
        data={data}
        section={settingsSection ?? "general"}
        sessionSort={sessionSort}
        setSessionSort={setSessionSort}
      />
    );
  } else {
    mainContent = (
      <Routes>
        <Route
          path="/"
          element={
            <OverviewPage
              data={overviewData}
              range={range}
              setRange={(nextRange) => updateSearchParam("range", nextRange)}
            />
          }
        />
        <Route path="/agents" element={<AgentsPage data={data} query="" />} />
        <Route path="/agents/:agentName" element={<AgentPage data={data} />} />
        <Route
          path="/projects"
          element={<ProjectsPage data={data} query="" />}
        />
        <Route
          path="/projects/:projectName"
          element={<ProjectPage data={data} />}
        />
        <Route path="/models/:modelName" element={<ModelPage data={data} />} />
        <Route
          path="/sessions"
          element={
            <SessionsPage
              data={data}
              deviceParam={deviceParam}
              query=""
              sessionSort={sessionSort}
            />
          }
        />
        <Route
          path="/sessions/:sessionId"
          element={<SessionPage data={data} deviceParam={deviceParam} />}
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    );
  }

  return (
    <div className="min-h-screen bg-background text-foreground">
      {authRequired && <PairingDialog />}
      <CommandPalette
        data={data}
        deviceParam={deviceParam}
        sessionSort={sessionSort}
        open={searchOpen}
        onOpenChange={setSearchOpen}
      />
      <aside className="fixed inset-y-0 left-0 z-20 hidden w-56 flex-col border-r bg-card px-4 py-5 lg:flex">
        <Link to="/" className="flex items-center gap-3">
          <div className="grid size-8 place-items-center rounded-md bg-primary text-primary-foreground">
            <Zap size={19} />
          </div>
          <div>
            <div className="font-semibold tracking-tight">TokTracker</div>
            <div className="text-xs text-muted-foreground">
              Usage intelligence
            </div>
          </div>
        </Link>
        {settingsOpen ? (
          <SettingsNavigation
            section={settingsSection ?? "general"}
            setSection={(section) => navigate(`/settings/${section}`)}
          />
        ) : (
          <Navigation data={data} />
        )}
        <div className="mt-auto">
          <button
            type="button"
            onClick={() => navigate(settingsOpen ? "/" : "/settings/general")}
            className="flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm text-muted-foreground transition hover:bg-muted hover:text-foreground"
          >
            {settingsOpen ? <ArrowLeft size={15} /> : <Settings size={15} />}
            {settingsOpen ? "Back" : "Settings"}
          </button>
        </div>
      </aside>
      <main className="lg:pl-56">
        <header className="sticky top-0 z-10 flex h-14 items-center gap-4 border-b bg-background/90 px-5 backdrop-blur md:px-8">
          <div className="hidden md:block">
            <h1 className="text-lg font-semibold">
              {settingsOpen ? "Settings" : pageTitle}
            </h1>
          </div>
          <button
            type="button"
            onClick={() => setSearchOpen(true)}
            className="mx-auto flex h-9 w-full max-w-xl items-center gap-2 rounded-md border bg-muted px-3 text-sm text-muted-foreground transition hover:bg-background hover:text-foreground"
          >
            <Search size={15} />
            <span className="truncate">
              Search agents, projects, models, sessions…
            </span>
            <kbd className="ml-auto hidden rounded border bg-background px-1.5 py-0.5 text-[10px] font-medium sm:inline">
              ⌘K
            </kbd>
          </button>
          <ThemeControl />
          {!settingsOpen && (
            <DeviceFilter
              devices={data.devices}
              selectedIds={selectedDeviceIds}
              setSelectedIds={(ids) =>
                updateSearchParam("devices", ids.join(","))
              }
            />
          )}
        </header>
        <Navigation data={data} mobile />
        <div className="mx-auto max-w-[1600px] p-4 md:p-6">{mainContent}</div>
      </main>
    </div>
  );
};
export default App;
