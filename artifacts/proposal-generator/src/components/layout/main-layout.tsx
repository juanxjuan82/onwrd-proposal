import { useState, useEffect } from "react";
import { Link, useLocation } from "wouter";
import {
  Plus, LayoutDashboard, Briefcase, Target, BookOpen,
  Settings, Inbox, UploadCloud, HelpCircle, X,
} from "lucide-react";

const NAV_ITEMS = [
  {
    href: "/",
    exact: true,
    icon: LayoutDashboard,
    label: "Dashboard",
    help: "Overview of all proposals, recent activity, and pipeline status.",
  },
  {
    href: "/new",
    exact: true,
    icon: Plus,
    label: "New Proposal",
    help: "Manually start a proposal by pasting or typing a project brief.",
  },
  {
    href: "/opportunities",
    exact: false,
    icon: Target,
    label: "Opportunities",
    help: "AI-scored tenders ready for bidding, with fit levels and strategy briefs.",
  },
  {
    href: "/tenders",
    exact: false,
    icon: Briefcase,
    label: "Tenders",
    help: "Full pipeline of every discovered tender — from raw find through analysis.",
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
    help: "Company documents and context the AI uses to shape proposals.",
  },
  {
    href: "/settings/sources",
    exact: false,
    icon: Target,
    label: "Sources",
    help: "Configure which websites the crawler monitors for new tenders.",
  },
  {
    href: "/settings/import",
    exact: false,
    icon: UploadCloud,
    label: "Import",
    help: "Manually feed a PDF, DOCX, or URL straight into the analysis pipeline.",
  },
  {
    href: "/settings",
    exact: true,
    icon: Settings,
    label: "Settings",
    help: "Connect your Google account and manage integrations.",
  },
];

export function MainLayout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
  const [showHelp, setShowHelp] = useState<boolean>(() => {
    try { return localStorage.getItem("onwrd_show_help") !== "false"; } catch { return true; }
  });

  useEffect(() => {
    try { localStorage.setItem("onwrd_show_help", showHelp ? "true" : "false"); } catch { /* ignore */ }
  }, [showHelp]);

  const isActive = (href: string, exact: boolean) =>
    exact ? location === href : location.startsWith(href);

  const navClass = (active: boolean) =>
    `relative flex flex-col pl-4 pr-4 py-2.5 text-sm font-medium tracking-wide transition-colors ${
      active
        ? "text-white border-l-[3px] border-[#0000FF] bg-transparent"
        : "text-[#999999] border-l-[3px] border-transparent hover:text-white"
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
                <Link key={href} href={href} className={navClass(active)}>
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
