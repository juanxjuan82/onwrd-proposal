import { useEffect, useRef } from "react";
import { Switch, Route, Router as WouterRouter, useParams, useLocation } from "wouter";
import { QueryClient, QueryClientProvider, QueryCache, MutationCache, useQueryClient } from "@tanstack/react-query";
import { ClerkProvider, SignIn, SignUp, useClerk } from "@clerk/react";
import { publishableKeyFromHost } from "@clerk/react/internal";
import { dark } from "@clerk/themes";
import { RequireAuth, notifySessionExpired, notifyAccessDenied, installUnauthorizedInterceptor } from "@/components/auth-gate";

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

// REQUIRED — copy verbatim. Resolves the key from window.location.hostname so the
// same build serves multiple Clerk custom domains. Do not inline the env var, leave
// publishableKey undefined, or replace publishableKeyFromHost with anything else.
const clerkPubKey = publishableKeyFromHost(
  window.location.hostname,
  import.meta.env.VITE_CLERK_PUBLISHABLE_KEY,
);

// REQUIRED — copy verbatim. Empty in dev (Clerk hits dev FAPI directly), auto-set
// in prod. Do NOT gate on import.meta.env.PROD / NODE_ENV — the empty dev value
// is intentional, and any branching breaks the prod proxy.
const clerkProxyUrl = import.meta.env.VITE_CLERK_PROXY_URL;

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

// Clerk passes full paths to routerPush/routerReplace, but wouter's
// setLocation prepends the base — strip it to avoid doubling.
function stripBase(path: string): string {
  return basePath && path.startsWith(basePath)
    ? path.slice(basePath.length) || "/"
    : path;
}

if (!clerkPubKey) {
  throw new Error("Missing VITE_CLERK_PUBLISHABLE_KEY in .env file");
}

const clerkAppearance = {
  theme: dark, // imported object from @clerk/themes; not a string
  cssLayerName: "clerk",
  options: {
    logoPlacement: "inside" as const,
    logoLinkUrl: basePath || "/",
    logoImageUrl: `${window.location.origin}${basePath}/onwrd-logo-white.png`,
  },
  variables: {
    colorPrimary: "#0000FF",
    colorForeground: "#FFFFFF",
    colorMutedForeground: "#999999",
    colorDanger: "#F87171",
    colorBackground: "#000000",
    colorInput: "#111111",
    colorInputForeground: "#FFFFFF",
    colorNeutral: "#333333",
    fontFamily: "'Helvetica Neue', Helvetica, Arial, sans-serif",
    borderRadius: "0px",
  },
  elements: {
    rootBox: "w-full flex justify-center",
    cardBox: "bg-black border border-[#222222] w-[400px] max-w-full overflow-hidden",
    card: "!shadow-none !border-0 !bg-transparent !rounded-none",
    footer: "!shadow-none !border-0 !bg-transparent !rounded-none",
    headerTitle: "text-white text-xl font-semibold",
    headerSubtitle: "text-[#999999]",
    socialButtonsBlockButtonText: "text-white font-medium",
    formFieldLabel: "text-[#999999]",
    footerActionLink: "text-[#0000FF] hover:opacity-80 font-semibold",
    footerActionText: "text-[#999999]",
    dividerText: "text-[#555555]",
    identityPreviewEditButton: "text-[#0000FF]",
    formFieldSuccessText: "text-[#999999]",
    alertText: "text-[#F87171]",
    logoBox: "flex justify-center py-6",
    logoImage: "h-10 object-contain",
    socialButtonsBlockButton: "!border-[#333333] hover:!bg-[#111111] transition-colors",
    formButtonPrimary: "bg-[#0000FF] hover:bg-[#2222FF] text-white font-semibold transition-colors",
    formFieldInput: "bg-[#111111] border-[#333333] text-white",
    footerAction: "pb-6",
    dividerLine: "bg-[#333333]",
    alert: "border-[#F87171]/40 bg-[#F87171]/10",
    otpCodeFieldInput: "bg-[#111111] border-[#333333] text-white",
    formFieldRow: "",
    main: "px-8 pb-8",
  },
};

function SignInPage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-black px-4">
      <SignIn routing="path" path={`${basePath}/sign-in`} signUpUrl={`${basePath}/sign-up`} />
    </div>
  );
}

function SignUpPage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-black px-4">
      <SignUp routing="path" path={`${basePath}/sign-up`} signInUrl={`${basePath}/sign-in`} />
    </div>
  );
}

const queryClient = new QueryClient({
  queryCache: new QueryCache({
    onError: (error) => {
      if (isUnauthorized(error)) notifySessionExpired();
      if (isForbiddenDomain(error)) notifyAccessDenied();
    },
  }),
  mutationCache: new MutationCache({
    onError: (error) => {
      if (isUnauthorized(error)) notifySessionExpired();
      if (isForbiddenDomain(error)) notifyAccessDenied();
    },
  }),
});

function isUnauthorized(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    (error as { status?: unknown }).status === 401
  );
}

function isForbiddenDomain(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    (error as { status?: unknown }).status === 403
  );
}

// Helps the webview stay up-to-date when the signed-in user changes by invalidating the QueryClient cache.
function ClerkQueryClientCacheInvalidator() {
  const { addListener } = useClerk();
  const qc = useQueryClient();
  const prevUserIdRef = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    const unsubscribe = addListener(({ user }) => {
      const userId = user?.id ?? null;
      if (prevUserIdRef.current !== undefined && prevUserIdRef.current !== userId) {
        qc.clear();
      }
      prevUserIdRef.current = userId;
    });
    return unsubscribe;
  }, [addListener, qc]);

  return null;
}

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

      {/* Dedicated Clerk sign-in / sign-up routes */}
      <Route path="/sign-in/*?" component={SignInPage} />
      <Route path="/sign-up/*?" component={SignUpPage} />

      {/* Admin routes — auth required, wrapped in MainLayout with sidebar */}
      <Route>
        <RequireAuth>
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
        </RequireAuth>
      </Route>
    </Switch>
  );
}

function ClerkProviderWithRoutes() {
  const [, setLocation] = useLocation();

  return (
    <ClerkProvider
      publishableKey={clerkPubKey}
      proxyUrl={clerkProxyUrl}
      appearance={clerkAppearance}
      signInUrl={`${basePath}/sign-in`}
      signUpUrl={`${basePath}/sign-up`}
      localization={{
        signIn: {
          start: {
            title: "Welcome back",
            subtitle: "Sign in with your ONWRD Google Workspace account",
          },
        },
        signUp: {
          start: {
            title: "Welcome",
            subtitle: "Sign in with your ONWRD Google Workspace account",
          },
        },
      }}
      routerPush={(to) => setLocation(stripBase(to))}
      routerReplace={(to) => setLocation(stripBase(to), { replace: true })}
    >
      <QueryClientProvider client={queryClient}>
        <ClerkQueryClientCacheInvalidator />
        <TooltipProvider>
          <Router />
          <Toaster />
        </TooltipProvider>
      </QueryClientProvider>
    </ClerkProvider>
  );
}

function App() {
  return (
    <WouterRouter base={basePath}>
      <ClerkProviderWithRoutes />
    </WouterRouter>
  );
}

export default App;
