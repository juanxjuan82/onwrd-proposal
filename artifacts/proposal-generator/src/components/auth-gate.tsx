import { useEffect, useState } from "react";
import { Redirect } from "wouter";
import { Show, useClerk } from "@clerk/react";

const SESSION_EXPIRED_EVENT = "onwrd:session-expired";
const ACCESS_DENIED_EVENT = "onwrd:access-denied";

/** Call when any API request returns 401 — surfaces the session-expired banner. */
export function notifySessionExpired() {
  window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT));
}

/** Call when the server rejects a signed-in Clerk user for being outside the company domain. */
export function notifyAccessDenied() {
  window.dispatchEvent(new Event(ACCESS_DENIED_EVENT));
}

/**
 * Patches window.fetch once so every direct API call that comes back
 * 401/403 surfaces the right banner — pages call fetch directly, so
 * react-query error hooks alone can't see the status code or error code.
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
      const isApiCall = url.includes("/api/") && !url.includes("/api/__clerk");
      if (isApiCall && res.status === 401) {
        notifySessionExpired();
      } else if (isApiCall && res.status === 403) {
        const body = await res
          .clone()
          .json()
          .catch(() => null);
        if (body?.code === "domain_not_allowed") {
          notifyAccessDenied();
        }
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
 * Terminal state for a Clerk-authenticated user whose Google account is
 * outside the company domain. Deliberately does NOT redirect to /sign-in —
 * Clerk still considers them signed in, so a redirect there would just
 * bounce back here (or worse, loop).
 */
export function AccessDeniedScreen() {
  const { signOut } = useClerk();
  return (
    <div className="min-h-screen bg-black text-white flex flex-col items-center justify-center px-6">
      <img
        src="/onwrd-logo-white.png"
        alt="ONWRD"
        className="h-12 object-contain mb-8"
      />
      <p className="text-[#999999] text-sm mb-6 text-center max-w-sm">
        This workspace is private. Sign in with a verified{" "}
        <span className="text-white">@onwrdadvisors.com</span> Google account
        to access proposals, opportunities, and settings.
      </p>
      <button
        onClick={() => signOut({ redirectUrl: window.location.origin + import.meta.env.BASE_URL })}
        className="bg-[#0000FF] hover:bg-[#2222FF] text-white text-sm font-semibold px-8 py-3 transition-colors"
        data-testid="button-access-denied-signout"
      >
        Try a different account
      </button>
    </div>
  );
}

/**
 * Blocks rendering of protected pages until the user is authenticated.
 * Unauthenticated visitors are redirected to the dedicated sign-in route.
 */
export function RequireAuth({ children }: { children: React.ReactNode }) {
  const [expired, setExpired] = useState(false);
  const [accessDenied, setAccessDenied] = useState(false);
  const { signOut, openSignIn } = useClerk();

  useEffect(() => {
    const expiredHandler = () => setExpired(true);
    const deniedHandler = () => setAccessDenied(true);
    window.addEventListener(SESSION_EXPIRED_EVENT, expiredHandler);
    window.addEventListener(ACCESS_DENIED_EVENT, deniedHandler);
    return () => {
      window.removeEventListener(SESSION_EXPIRED_EVENT, expiredHandler);
      window.removeEventListener(ACCESS_DENIED_EVENT, deniedHandler);
    };
  }, []);

  if (accessDenied) {
    return <AccessDeniedScreen />;
  }

  return (
    <>
      <Show when="signed-in">
        {expired && (
          <SessionExpiredBanner onLogin={() => openSignIn()} />
        )}
        {children}
      </Show>
      <Show when="signed-out">
        <Redirect to="/sign-in" />
      </Show>
    </>
  );
}
