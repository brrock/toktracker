import type { SessionSort, TimeRange } from "@toktracker/shared";
import { ArrowLeft, Search, Settings } from "lucide-react";
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

import { QuickAppearanceMenu } from "@/components/dashboard/appearance-controls";
import { DeviceFilter } from "@/components/dashboard/filters";
import {
  ConnectionStatus,
  Navigation,
} from "@/components/dashboard/navigation";
import { PairingDialog } from "@/components/dashboard/pairing-dialog";
import { BrandMark, PageSkeleton } from "@/components/dashboard/primitives";
import { AUTH_REQUIRED_EVENT, apiFetch } from "@/lib/api";
import { EMPTY_SUMMARY } from "@/lib/dashboard";
import { Link, NAV_ITEMS } from "@/lib/navigation";
import {
  isOnboardingComplete,
  markOnboardingComplete,
  ONBOARDING_PATH,
} from "@/lib/onboarding";
import { dashboardSummarySchema, timeRangeSchema } from "@/lib/schemas";
import { parseSettingsPath } from "@/lib/settings-path";
import { OverviewPage } from "@/pages/overview-page";

// The overview is the landing page; everything else loads on demand so the
// first paint does not wait for settings, search and detail pages.
const CommandPalette = lazy(async () => {
  const module = await import("@/components/dashboard/command-palette");
  return { default: module.CommandPalette };
});
const Onboarding = lazy(async () => {
  const module = await import("@/components/dashboard/onboarding");
  return { default: module.Onboarding };
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

// The tour shows once per browser, and again whenever /welcome is opened.
interface OnboardingState {
  finishOnboarding: () => void;
  showOnboarding: boolean;
}

const OVERVIEW_PATHS = new Set(["/", ONBOARDING_PATH]);

const useOnboarding = (authRequired: boolean): OnboardingState => {
  const [complete, setComplete] = useState(isOnboardingComplete);
  const location = useLocation();
  const navigate = useNavigate();
  const onWelcomePath = location.pathname === ONBOARDING_PATH;
  const finishOnboarding = useCallback((): void => {
    markOnboardingComplete();
    setComplete(true);
    if (onWelcomePath) {
      navigate("/");
    }
  }, [navigate, onWelcomePath]);
  return {
    finishOnboarding,
    showOnboarding: !authRequired && (!complete || onWelcomePath),
  };
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

  const { finishOnboarding, showOnboarding } = useOnboarding(authRequired);
  const isOverviewRoute = OVERVIEW_PATHS.has(location.pathname);
  const loading =
    isOverviewRoute && !settingsOpen ? overviewLoading : globalLoading;
  let mainContent: React.ReactNode;
  if (loading) {
    mainContent = <PageSkeleton />;
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
          path={ONBOARDING_PATH}
          element={
            <OverviewPage
              data={overviewData}
              range={range}
              setRange={(nextRange) => updateSearchParam("range", nextRange)}
            />
          }
        />
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
    <div className="relative min-h-screen bg-background text-foreground">
      <div className="app-backdrop" />
      {authRequired && <PairingDialog />}
      {showOnboarding && (
        <Suspense fallback={null}>
          <Onboarding devices={data.devices} onFinish={finishOnboarding} />
        </Suspense>
      )}
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
      <aside className="fixed inset-y-0 left-0 z-20 hidden w-60 flex-col border-r bg-sidebar/85 px-4 py-5 backdrop-blur-xl lg:flex">
        <Link to="/" className="flex items-center gap-3 px-1">
          <BrandMark />
          <div>
            <div className="font-heading font-semibold leading-tight">
              TokTracker
            </div>
            <div className="text-[11px] text-muted-foreground">
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
        <div className="mt-auto space-y-2 pt-4">
          <ConnectionStatus devices={data.devices} />
          <button
            type="button"
            onClick={() => navigate(settingsOpen ? "/" : "/settings/general")}
            className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm text-muted-foreground transition hover:bg-muted hover:text-foreground"
          >
            {settingsOpen ? <ArrowLeft size={15} /> : <Settings size={15} />}
            {settingsOpen ? "Back to dashboard" : "Settings"}
          </button>
        </div>
      </aside>
      <main className="relative lg:pl-60">
        <header className="sticky top-0 z-10 flex h-16 items-center gap-3 border-b bg-background/85 px-4 backdrop-blur-xl md:px-8">
          <Link to="/" className="lg:hidden">
            <BrandMark className="size-8" />
          </Link>
          <div className="hidden min-w-0 md:block">
            <h1 className="truncate text-base font-semibold">
              {settingsOpen ? "Settings" : pageTitle}
            </h1>
          </div>
          <button
            type="button"
            onClick={() => {
              setSearchLoaded(true);
              setSearchOpen(true);
            }}
            className="mx-auto flex h-9 min-w-0 max-w-lg flex-1 items-center gap-2 rounded-lg border bg-card/80 px-3 text-sm text-muted-foreground shadow-xs transition hover:border-foreground/20 hover:text-foreground"
          >
            <Search size={15} />
            <span className="truncate">
              Search agents, projects, models, sessions…
            </span>
            <kbd className="ml-auto hidden rounded-md border bg-muted px-1.5 py-0.5 font-mono text-[10px] font-medium sm:inline">
              ⌘K
            </kbd>
          </button>
          <QuickAppearanceMenu />
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
        <div className="mx-auto max-w-[1600px] p-4 md:p-8">
          <Suspense fallback={<PageSkeleton />}>{mainContent}</Suspense>
        </div>
      </main>
    </div>
  );
};
export default App;
