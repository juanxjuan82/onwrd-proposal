import { useState, useEffect, useRef } from "react";
import { Link, useLocation } from "wouter";
import {
  Plus, Target, LayoutDashboard, BookOpen, Settings,
  Upload, FileText, Pencil, Link2, ChevronDown, X,
} from "lucide-react";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

export function MainLayout({ children }: { children: React.ReactNode }) {
  const [location, navigate] = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);
  const [showIntakeModal, setShowIntakeModal] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const handle = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, [menuOpen]);

  const inSettings = location.startsWith("/settings");

  const isActive = (href: string, exact = false) =>
    exact ? location === href : location.startsWith(href);

  const navClass = (active: boolean) =>
    `relative flex flex-col pl-4 pr-4 py-2.5 text-sm font-medium tracking-wide transition-colors ${
      active
        ? "text-white border-l-[3px] border-[#0000FF] bg-transparent"
        : "text-[#999999] border-l-[3px] border-transparent hover:text-white"
    }`;

  const subNavClass = (active: boolean) =>
    `pl-8 pr-4 py-1.5 text-xs font-medium transition-colors block border-l-[3px] ${
      active ? "text-white border-[#0000FF]" : "text-[#555] border-transparent hover:text-[#999]"
    }`;

  const intakeUrl = `${window.location.origin}${BASE}/intake`;

  const menuItems: { label: string; icon: React.ElementType; action: () => void }[] = [
    {
      label: "Import RFP",
      icon: Upload,
      action: () => { navigate("/new?mode=import"); setMenuOpen(false); },
    },
    {
      label: "Paste RFP Text",
      icon: FileText,
      action: () => { navigate("/new?mode=paste"); setMenuOpen(false); },
    },
    {
      label: "Add Opportunity Manually",
      icon: Pencil,
      action: () => { navigate("/new?mode=manual"); setMenuOpen(false); },
    },
    {
      label: "Create Blank Proposal",
      icon: LayoutDashboard,
      action: () => { navigate("/new?mode=blank"); setMenuOpen(false); },
    },
    {
      label: "Prospect Intake Link",
      icon: Link2,
      action: () => { setMenuOpen(false); setShowIntakeModal(true); },
    },
  ];

  return (
    <div className="min-h-screen bg-black text-white flex flex-col md:flex-row">
      <aside className="w-full md:w-[220px] border-r border-[#222222] bg-black flex-shrink-0 flex flex-col">
        <div className="px-6 py-8 flex flex-col flex-1">
          {/* Logo */}
          <div className="mb-8">
            <img
              src="/onwrd-logo-white.png"
              alt="ONWRD"
              className="h-12 w-full object-contain object-left"
            />
          </div>

          {/* + New dropdown */}
          <div className="relative mb-6" ref={menuRef}>
            <button
              onClick={() => setMenuOpen(v => !v)}
              className="w-full flex items-center justify-between gap-2 px-4 py-2.5 rounded-md bg-[#0000FF] hover:bg-[#0000dd] text-white text-sm font-medium transition-colors"
            >
              <span className="flex items-center gap-2">
                <Plus className="w-4 h-4" />
                New
              </span>
              <ChevronDown
                className={`w-3.5 h-3.5 transition-transform ${menuOpen ? "rotate-180" : ""}`}
              />
            </button>
            {menuOpen && (
              <div className="absolute left-0 top-full mt-1 z-50 bg-[#111] border border-[#333] rounded-md shadow-2xl overflow-hidden min-w-[240px]">
                {menuItems.map(({ label, icon: Icon, action }) => (
                  <button
                    key={label}
                    onClick={action}
                    className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-[#ccc] hover:text-white hover:bg-[#1a1a1a] transition-colors text-left"
                  >
                    <Icon className="w-3.5 h-3.5 flex-shrink-0 text-[#666]" />
                    {label}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Nav */}
          <nav className="-mx-6 flex-1 space-y-0">
            {/* WORKFLOW section */}
            <div className="px-4 pb-1">
              <span className="text-[10px] font-semibold uppercase tracking-widest text-[#444]">
                Workflow
              </span>
            </div>

            <Link href="/opportunities" className={navClass(isActive("/opportunities"))}>
              <div className="flex items-center gap-3">
                <Target className="w-5 h-5 flex-shrink-0" />
                <span>Opportunities</span>
              </div>
            </Link>

            <Link href="/" className={navClass(location === "/")}>
              <div className="flex items-center gap-3">
                <LayoutDashboard className="w-5 h-5 flex-shrink-0" />
                <span>Proposals</span>
              </div>
            </Link>

            {/* WORKSPACE section */}
            <div className="px-4 pb-1 pt-4">
              <span className="text-[10px] font-semibold uppercase tracking-widest text-[#444]">
                Workspace
              </span>
            </div>

            <Link href="/knowledge" className={navClass(isActive("/knowledge"))}>
              <div className="flex items-center gap-3">
                <BookOpen className="w-5 h-5 flex-shrink-0" />
                <span>Knowledge</span>
              </div>
            </Link>

            <div>
              <Link href="/settings" className={navClass(inSettings)}>
                <div className="flex items-center gap-3">
                  <Settings className="w-5 h-5 flex-shrink-0" />
                  <span>Settings</span>
                </div>
              </Link>
              {inSettings && (
                <div className="mb-1">
                  <Link
                    href="/settings"
                    className={subNavClass(location === "/settings")}
                  >
                    Google Docs
                  </Link>
                  <Link
                    href="/settings/sources"
                    className={subNavClass(isActive("/settings/sources"))}
                  >
                    Sources
                  </Link>
                </div>
              )}
            </div>
          </nav>

        </div>
      </aside>

      <main className="flex-1 overflow-auto bg-black">{children}</main>

      {/* Prospect Intake share modal */}
      {showIntakeModal && (
        <div
          className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4"
          onClick={() => setShowIntakeModal(false)}
        >
          <div
            className="bg-[#111] border border-[#333] rounded-xl p-6 max-w-md w-full shadow-2xl"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-white font-semibold text-base">Prospect Intake Link</h2>
              <button
                onClick={() => setShowIntakeModal(false)}
                className="text-[#555] hover:text-white transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <p className="text-[#888] text-sm mb-4">
              Share this link with prospects to capture their brief and automatically create an opportunity in the pipeline.
            </p>
            <div className="flex gap-2">
              <input
                readOnly
                value={intakeUrl}
                className="flex-1 bg-[#1a1a1a] border border-[#333] rounded-md px-3 py-2 text-sm text-white font-mono select-all"
                onFocus={e => e.target.select()}
              />
              <button
                onClick={() => { navigator.clipboard.writeText(intakeUrl).catch(() => {}); }}
                className="px-3 py-2 bg-[#0000FF] hover:bg-[#0000dd] text-white text-xs rounded-md font-medium transition-colors whitespace-nowrap"
              >
                Copy
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
