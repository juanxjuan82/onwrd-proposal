import { Switch, Route, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";

import { MainLayout } from "./components/layout/main-layout";
import Home from "./pages/home";
import NewProposal from "./pages/new-proposal";
import ProposalDetail from "./pages/proposal-detail";
import Intake from "./pages/intake";
import Tenders from "./pages/tenders";
import TenderDetail from "./pages/tender-detail";
import Opportunities from "./pages/opportunities";
import OpportunityDetail from "./pages/opportunity-detail";
import Knowledge from "./pages/knowledge";
import SettingsGoogle from "./pages/settings-google";

const queryClient = new QueryClient();

function Router() {
  return (
    <Switch>
      {/* Public client-facing route — no admin sidebar */}
      <Route path="/intake" component={Intake} />

      {/* Admin routes — wrapped in MainLayout with sidebar */}
      <Route>
        <MainLayout>
          <Switch>
            <Route path="/" component={Home} />
            <Route path="/new" component={NewProposal} />
            <Route path="/proposals/:id" component={ProposalDetail} />
            <Route path="/tenders" component={Tenders} />
            <Route path="/tenders/:id" component={TenderDetail} />
            <Route path="/opportunities" component={Opportunities} />
            <Route path="/opportunities/:id" component={OpportunityDetail} />
            <Route path="/knowledge" component={Knowledge} />
            <Route path="/settings" component={SettingsGoogle} />
            <Route component={NotFound} />
          </Switch>
        </MainLayout>
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
