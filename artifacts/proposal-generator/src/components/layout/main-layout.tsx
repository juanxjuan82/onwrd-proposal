import { useState, useEffect } from "react";
import { Link, useLocation } from "wouter";
import {
  Plus, LayoutDashboard, Briefcase, Target, BookOpen,
  Settings, Inbox, HelpCircle, X, FileText,
} from "lucide-react";

const NAV_ITEMS = [
  {
    href: "/",
    exact: true,
    icon: LayoutDashboard,
    label: "Proposals",
    help: "All active proposals — draft, in progress, and exported.",
  },
  {
    href: "/new",
    exact: true,
    icon: Plus,
    label: "New Proposal",
    help: "Start a proposal from a brief, or import an RFP document.",
  },
  {
    href: "/opportunities",
    exact: false,
    icon: Target,
    label: "Opportunities",
    help: "Incoming tenders to score and decide: pursue or pass.",
  },
  {
    href: "/tenders",
    exact: false,
    icon: Briefcase,
    label: "Tenders",
    help: "Full pipeline of every discovered tender — raw finds through analysis.",
  },
  {
    href: "/inbox",
    exact: false,
    icon: Inbox,
    label: "Inbox",
    help: "New tender matches from the automated daily crawl, pending review.",
  },
  {
    href: "/knowledge",
    exact: false,
    icon: BookOpen,
    label: "Knowledge",
    help: "Company documents the AI uses to shape proposals.",
  },
  {
    href: "/settings",
    exact: false,
    icon: Settings,
    label: "Settings",
    help: "Google Docs integration, crawler sources, and document import.",
  },
];

const SETTINGS_SUB_ITEMS = [
  { href: "/settings",         exact: true,  label: "Google Docs" },
  { href: "/settings/sources", exact: false, label: "Sources" },
  { href: "/settings/import",  exact: false, label: "Import RFP" },
];

export function MainLayout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
  const [showHelp, setShowHelp] = useState<boolean>(() => {
    try { return localStorage.getItem("onwrd_show_help") !== "false"; } catch { return true; }
  });

  useEffect(() => {
    try { localStorage.setItem("onwrd_show_help", showHelp ? "true" : "false"); } catch { /* ignore */ }
  }, [showHelp]);

  const inSettings = location.startsWith("/settings");

  const isActive = (href: string, exact: boolean) =>
    exact ? location === href : location.startsWith(href);

  const navClass = (active: boolean) =>
    `relative flex flex-col pl-4 pr-4 py-2.5 text-sm font-medium tracking-wide transition-colors ${
      active
        ? "text-white border-l-[3px] border-[#0000FF] bg-transparent"
        : "text-[#999999] border-l-[3px] border-transparent hover:text-white"
    }`;

  const subNavClass = (active: boolean) =>
    `pl-8 pr-4 py-1.5 text-xs font-medium transition-colors block border-l-[3px] ${
      active
        ? "text-white border-[#0000FF]"
        : "text-[#555] border-transparent hover:text-[#999]"
    }`;

  return (
    <div className="min-h-screen bg-black text-white flex flex-col md:flex-row">
      <aside className="w-full md:w-[220px] border-r border-[#222222] bg-black flex-shrink-0 flex flex-col">
        <div className="px-6 py-8 flex flex-col flex-1">
          {/* Logo */}
          <div className="mb-12">
            <img
              src="/onwrd-logo-white.png"
              alt="ONWRD"
              className="h-12 w-full object-contain object-left"
            />
          </div>

          {/* Nav */}
          <nav className="space-y-0.5 -mx-6 flex-1">
            {NAV_ITEMS.map(({ href, exact, icon: Icon, label, help }) => {
              const active = isActive(href, exact);
              return (
                <div key={href}>
                  <Link href={href} className={navClass(active)}>
                    <div className="flex items-center gap-3">
                      <Icon className="w-5 h-5 flex-shrink-0" />
                      <span>{label}</span>
                    </div>
                    {showHelp && (
                      <p className="mt-0.5 ml-8 text-[11px] font-normal leading-snug text-[#555] whitespace-normal">
                        {help}
                      </p>
                    )}
                  </Link>

                  {/* Settings sub-items — shown when in /settings section */}
                  {href === "/settings" && inSettings && (
                    <div className="mb-1">
                      {SETTINGS_SUB_ITEMS.map((sub) => (
                        <Link
                          key={sub.href}
                          href={sub.href}
                          className={subNavClass(isActive(sub.href, sub.exact))}
                        >
                          {sub.label}
                        </Link>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </nav>

          {/* Help toggle */}
          <div className="-mx-6 mt-4 pt-4 border-t border-[#1a1a1a]">
            <button
              onClick={() => setShowHelp(v => !v)}
              className="flex items-center gap-2.5 w-full pl-4 pr-4 py-2.5 text-[#555] hover:text-white transition-colors text-[12px] font-medium"
            >
              {showHelp ? (
                <>
                  <X className="w-4 h-4 flex-shrink-0" />
                  Hide hints
                </>
              ) : (
                <>
                  <HelpCircle className="w-4 h-4 flex-shrink-0" />
                  Show hints
                </>
              )}
            </button>
          </div>
        </div>
      </aside>

      <main className="flex-1 overflow-auto bg-black">{children}</main>
    </div>
  );
}
