import type { SessionSort, TimeRange } from "@toktracker/shared";
import { ArrowLeft, Search, Settings, Zap } from "lucide-react";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  Navigate,
  Route,
  Routes,
  useLocation,
  useNavigate,
  useSearchParams,
} from "react-router-dom";

import { DeviceFilter, ThemeControl } from "@/components/dashboard/filters";
import { Navigation } from "@/components/dashboard/navigation";
import { PairingDialog } from "@/components/dashboard/pairing-dialog";
import { EmptyState } from "@/components/dashboard/primitives";
import { AUTH_REQUIRED_EVENT, apiFetch } from "@/lib/api";
import { EMPTY_SUMMARY } from "@/lib/dashboard";
import { Link, NAV_ITEMS } from "@/lib/navigation";
import { dashboardSummarySchema, timeRangeSchema } from "@/lib/schemas";
import { parseSettingsPath } from "@/lib/settings-path";
import { OverviewPage } from "@/pages/overview-page";

// The overview is the landing page; everything else loads on demand so the
// first paint does not wait for settings, search and detail pages.
const CommandPalette = lazy(async () => {
  const module = await import("@/components/dashboard/command-palette");
  return { default: module.CommandPalette };
});
const SettingsNavigation = lazy(async () => {
  const module = await import("@/components/dashboard/settings");
  return { default: module.SettingsNavigation };
});
const SettingsPage = lazy(async () => {
  const module = await import("@/components/dashboard/settings");
  return { default: module.SettingsPage };
});
const AgentPage = lazy(async () => {
  const module = await import("@/pages/agents-page");
  return { default: module.AgentPage };
});
const AgentsPage = lazy(async () => {
  const module = await import("@/pages/agents-page");
  return { default: module.AgentsPage };
});
const ModelPage = lazy(async () => {
  const module = await import("@/pages/model-page");
  return { default: module.ModelPage };
});
const ProjectPage = lazy(async () => {
  const module = await import("@/pages/projects-page");
  return { default: module.ProjectPage };
});
const ProjectsPage = lazy(async () => {
  const module = await import("@/pages/projects-page");
  return { default: module.ProjectsPage };
});
const SessionPage = lazy(async () => {
  const module = await import("@/pages/sessions-page");
  return { default: module.SessionPage };
});
const SessionsPage = lazy(async () => {
  const module = await import("@/pages/sessions-page");
  return { default: module.SessionsPage };
});

const SESSION_SORT_STORAGE_KEY = "toktracker-session-sort";

const fetchSummary = async (
  parameters: URLSearchParams,
  signal: AbortSignal
) => {
  const response = await apiFetch(`/api/v1/summary?${parameters}`, { signal });
  if (!response.ok) {
    throw new Error("Summary request failed");
  }
  return dashboardSummarySchema.parse(await response.json());
};

const App = () => {
  const [data, setData] = useState(EMPTY_SUMMARY);
  const [sessionSort, setSessionSort] = useState<SessionSort>(() =>
    window.localStorage.getItem(SESSION_SORT_STORAGE_KEY) === "createdAt"
      ? "createdAt"
      : "lastSeen"
  );
  const [overviewData, setOverviewData] = useState(EMPTY_SUMMARY);
  const [overviewLoading, setOverviewLoading] = useState(true);
  const [globalLoading, setGlobalLoading] = useState(true);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchLoaded, setSearchLoaded] = useState(false);
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

  // The overview (current range) and the all-time summary load
  // independently: the overview renders as soon as its smaller summary
  // arrives, and changing the range does not refetch all-time data.
  useEffect(() => {
    const controller = new AbortController();
    const loadOverview = async (): Promise<void> => {
      const parameters = new URLSearchParams({ range, sessionSort });
      if (deviceParam) {
        parameters.set("devices", deviceParam);
      }
      try {
        const summary = await fetchSummary(parameters, controller.signal);
        setOverviewData(summary);
      } catch {
        if (!controller.signal.aborted) {
          setOverviewData(EMPTY_SUMMARY);
        }
      } finally {
        if (!controller.signal.aborted) {
          setOverviewLoading(false);
        }
      }
    };
    loadOverview();
    return () => controller.abort();
  }, [deviceParam, range, sessionSort]);

  // The gateway computes summaries one at a time, so on the landing page ask
  // for the heavier all-time summary only once the overview has painted.
  const globalSummaryReady = location.pathname !== "/" || !overviewLoading;
  useEffect(() => {
    if (!globalSummaryReady) {
      return;
    }
    const controller = new AbortController();
    const loadGlobal = async (): Promise<void> => {
      const parameters = new URLSearchParams({
        includeAllDevices: "true",
        range: "all",
        sessionSort,
      });
      if (deviceParam) {
        parameters.set("devices", deviceParam);
      }
      try {
        const summary = await fetchSummary(parameters, controller.signal);
        setData(summary);
      } catch {
        if (!controller.signal.aborted) {
          setData(EMPTY_SUMMARY);
        }
      } finally {
        if (!controller.signal.aborted) {
          setGlobalLoading(false);
        }
      }
    };
    loadGlobal();
    return () => controller.abort();
  }, [deviceParam, globalSummaryReady, sessionSort]);

  useEffect(() => {
    const openSearch = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setSearchLoaded(true);
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

  const isOverviewRoute = location.pathname === "/";
  const loading =
    isOverviewRoute && !settingsOpen ? overviewLoading : globalLoading;
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
      {searchLoaded && (
        <Suspense fallback={null}>
          <CommandPalette
            data={data}
            deviceParam={deviceParam}
            sessionSort={sessionSort}
            open={searchOpen}
            onOpenChange={setSearchOpen}
          />
        </Suspense>
      )}
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
          <Suspense fallback={null}>
            <SettingsNavigation
              section={settingsSection ?? "general"}
              setSection={(section) => navigate(`/settings/${section}`)}
            />
          </Suspense>
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
            onClick={() => {
              setSearchLoaded(true);
              setSearchOpen(true);
            }}
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
        <div className="mx-auto max-w-[1600px] p-4 md:p-6">
          <Suspense fallback={<EmptyState>Loading…</EmptyState>}>
            {mainContent}
          </Suspense>
        </div>
      </main>
    </div>
  );
};
export default App;
