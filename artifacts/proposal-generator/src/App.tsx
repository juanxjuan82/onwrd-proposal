import { useEffect } from "react";
import { Switch, Route, Router as WouterRouter, useParams, useLocation } from "wouter";
import { QueryClient, QueryClientProvider, QueryCache, MutationCache } from "@tanstack/react-query";
import { AuthGate, notifySessionExpired, installUnauthorizedInterceptor } from "@/components/auth-gate";

installUnauthorizedInterceptor();
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";

import { MainLayout } from "./components/layout/main-layout";
import Home from "./pages/home";
import ProposalsWorkspace from "./pages/proposals-workspace";
import NewProposal from "./pages/new-proposal";
import ProposalDetail from "./pages/proposal-detail";
import Intake from "./pages/intake";
import Tenders from "./pages/tenders";
import Opportunities from "./pages/opportunities";
import OpportunityDetail from "./pages/tender-detail";
import Knowledge from "./pages/knowledge";
import SettingsGoogle from "./pages/settings-google";
import OpportunityInbox from "./pages/opportunity-inbox";
import SettingsSources from "./pages/settings-sources";
import SettingsImport from "./pages/settings-import";

function isUnauthorized(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    (error as { status?: unknown }).status === 401
  );
}

const queryClient = new QueryClient({
  queryCache: new QueryCache({
    onError: (error) => {
      if (isUnauthorized(error)) notifySessionExpired();
    },
  }),
  mutationCache: new MutationCache({
    onError: (error) => {
      if (isUnauthorized(error)) notifySessionExpired();
    },
  }),
});

// Generic redirect for legacy URL paths
function Redirect({ to }: { to: string }) {
  const [, setLocation] = useLocation();
  useEffect(() => { setLocation(to, { replace: true }); }, [to, setLocation]);
  return null;
}

// Redirect legacy /tenders/:id URLs to the canonical /opportunities/:id route.
function TenderDetailRedirect() {
  const { id } = useParams<{ id: string }>();
  const [, setLocation] = useLocation();
  useEffect(() => {
    setLocation(`/opportunities/${id}`, { replace: true });
  }, [id, setLocation]);
  return null;
}

function Router() {
  return (
    <Switch>
      {/* Public client-facing route — no admin sidebar */}
      <Route path="/intake" component={Intake} />

      {/* Admin routes — auth required, wrapped in MainLayout with sidebar */}
      <Route>
        <AuthGate>
        <MainLayout>
          <Switch>
            <Route path="/" component={() => <Redirect to="/proposals" />} />
            <Route path="/proposals" component={ProposalsWorkspace} />
            <Route path="/new" component={NewProposal} />
            <Route path="/proposals/:id" component={ProposalDetail} />
            {/* Legacy routes → canonical */}
            <Route path="/tenders/:id" component={TenderDetailRedirect} />
            <Route path="/tenders" component={() => <Redirect to="/opportunities" />} />
            <Route path="/inbox" component={() => <Redirect to="/opportunities" />} />
            <Route path="/discover" component={() => <Redirect to="/opportunities" />} />
            <Route path="/settings/import" component={() => <Redirect to="/new?mode=import" />} />
            <Route path="/opportunities" component={Opportunities} />
            <Route path="/opportunities/:id" component={OpportunityDetail} />
            <Route path="/knowledge" component={Knowledge} />
            <Route path="/settings" component={SettingsGoogle} />
            <Route path="/settings/sources" component={SettingsSources} />
            <Route component={NotFound} />
          </Switch>
        </MainLayout>
        </AuthGate>
      </Route>
    </Switch>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
          <Router />
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
