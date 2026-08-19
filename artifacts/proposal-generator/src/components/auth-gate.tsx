import { useEffect, useState } from "react";
import { useAuth } from "@workspace/replit-auth-web";

const SESSION_EXPIRED_EVENT = "onwrd:session-expired";

/** Call when any API request returns 401 — surfaces the session-expired banner. */
export function notifySessionExpired() {
  window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT));
}

/**
 * Patches window.fetch once so every direct API call that comes back 401
 * surfaces the session-expired banner — pages call fetch directly, so
 * react-query error hooks alone can't see the status code.
 */
let fetchPatched = false;
export function installUnauthorizedInterceptor() {
  if (fetchPatched) return;
  fetchPatched = true;
  const original = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const res = await original(input, init);
    try {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.pathname
            : input.url;
      if (res.status === 401 && url.includes("/api/") && !url.includes("/api/auth/")) {
        notifySessionExpired();
      }
    } catch {
      // never break the caller over banner bookkeeping
    }
    return res;
  };
}

function SessionExpiredBanner({ onLogin }: { onLogin: () => void }) {
  return (
    <div className="fixed top-0 inset-x-0 z-[100] bg-[#0000FF] text-white text-sm px-4 py-2.5 flex items-center justify-center gap-4">
      <span>Your session has expired.</span>
      <button
        onClick={onLogin}
        className="underline font-semibold hover:opacity-80"
        data-testid="button-session-expired-login"
      >
        Log in again
      </button>
    </div>
  );
}

/**
 * Blocks rendering of protected pages until the user is authenticated.
 * Unauthenticated visitors see a minimal login screen.
 */
export function AuthGate({ children }: { children: React.ReactNode }) {
  const { isLoading, isAuthenticated, login } = useAuth();
  const [expired, setExpired] = useState(false);
  const googleError = new URLSearchParams(window.location.search).get("google_error");

  useEffect(() => {
    const handler = () => setExpired(true);
    window.addEventListener(SESSION_EXPIRED_EVENT, handler);
    return () => window.removeEventListener(SESSION_EXPIRED_EVENT, handler);
  }, []);

  if (isLoading) {
    return (
      <div className="min-h-screen bg-black flex items-center justify-center">
        <div className="w-6 h-6 border-2 border-[#333] border-t-white rounded-full animate-spin" />
      </div>
    );
  }

  if (!isAuthenticated) {
    return (
      <div className="min-h-screen bg-black text-white flex flex-col items-center justify-center px-6">
        <img
          src="/onwrd-logo-white.png"
          alt="ONWRD"
          className="h-12 object-contain mb-8"
        />
        <p className="text-[#999999] text-sm mb-6 text-center max-w-sm">
          This workspace is private. Sign in with your ONWRD Google Workspace
          account to access proposals, opportunities, and settings.
        </p>
        {googleError && (
          <p className="text-sm text-red-300 mb-5 text-center max-w-sm">
            {googleError === "domain_not_allowed"
              ? "Use a verified @onwrdadvisors.com Google account."
              : "Google sign-in could not be completed. Please try again."}
          </p>
        )}
        <button
          onClick={login}
          className="bg-[#0000FF] hover:bg-[#2222FF] text-white text-sm font-semibold px-8 py-3 transition-colors"
          data-testid="button-login"
        >
          Continue with Google
        </button>
      </div>
    );
  }

  return (
    <>
      {expired && <SessionExpiredBanner onLogin={login} />}
      {children}
    </>
  );
}
