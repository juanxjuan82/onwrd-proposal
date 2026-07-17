import { Link, useLocation } from "wouter";
import { Plus, LayoutDashboard, Briefcase, Target, BookOpen, Settings, Inbox, UploadCloud } from "lucide-react";

export function MainLayout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();

  const navItem = (active: boolean) =>
    `relative flex items-center gap-3 pl-4 pr-4 py-3 text-sm font-medium tracking-wide transition-colors ${
      active
        ? "text-white border-l-[3px] border-[#0000FF] bg-transparent"
        : "text-[#999999] border-l-[3px] border-transparent hover:text-white"
    }`;

  return (
    <div className="min-h-screen bg-black text-white flex flex-col md:flex-row">
      <aside className="w-full md:w-[220px] border-r border-[#222222] bg-black flex-shrink-0 flex flex-col">
        <div className="px-6 py-8 flex flex-col flex-1">
          <div className="mb-12">
            <img
              src="/onwrd-logo-white.png"
              alt="ONWRD"
              className="h-12 w-full object-contain object-left"
            />
          </div>

          <nav className="space-y-1 -mx-6">
            <Link href="/" className={navItem(location === "/")} data-testid="nav-home">
              <LayoutDashboard className="w-5 h-5 flex-shrink-0" />
              Dashboard
            </Link>
            <Link href="/new" className={navItem(location === "/new")} data-testid="nav-new">
              <Plus className="w-5 h-5 flex-shrink-0" />
              New Proposal
            </Link>
            <Link
              href="/opportunities"
              className={navItem(location.startsWith("/opportunities"))}
              data-testid="nav-opportunities"
            >
              <Target className="w-5 h-5 flex-shrink-0" />
              Opportunities
            </Link>
            <Link
              href="/tenders"
              className={navItem(location.startsWith("/tenders"))}
              data-testid="nav-tenders"
            >
              <Briefcase className="w-5 h-5 flex-shrink-0" />
              Tenders
            </Link>
            <Link
              href="/inbox"
              className={navItem(location.startsWith("/inbox"))}
              data-testid="nav-inbox"
            >
              <Inbox className="w-5 h-5 flex-shrink-0" />
              Inbox
            </Link>
            <Link
              href="/knowledge"
              className={navItem(location.startsWith("/knowledge"))}
              data-testid="nav-knowledge"
            >
              <BookOpen className="w-5 h-5 flex-shrink-0" />
              Knowledge
            </Link>
            <Link
              href="/settings/sources"
              className={navItem(location.startsWith("/settings/sources"))}
              data-testid="nav-sources"
            >
              <Target className="w-5 h-5 flex-shrink-0" />
              Sources
            </Link>
            <Link
              href="/settings/import"
              className={navItem(location.startsWith("/settings/import"))}
              data-testid="nav-import"
            >
              <UploadCloud className="w-5 h-5 flex-shrink-0" />
              Import
            </Link>
            <Link
              href="/settings"
              className={navItem(location === "/settings")}
              data-testid="nav-settings"
            >
              <Settings className="w-5 h-5 flex-shrink-0" />
              Settings
            </Link>
          </nav>

        </div>
      </aside>
      <main className="flex-1 overflow-auto bg-black">{children}</main>
    </div>
  );
}
