import { Link, useLocation } from "wouter";
import { Plus, LayoutDashboard, Briefcase } from "lucide-react";
import { GoogleConnect } from "@/components/google-connect";

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
      <aside className="w-full md:w-40 border-r border-[#222222] bg-black flex-shrink-0 flex flex-col">
        <div className="px-6 py-8 flex flex-col flex-1">
          <div className="mb-12 px-4">
            <img
              src="/onwrd-logo-white.png"
              alt="ONWRD"
              className="h-7 object-contain object-left"
            />
          </div>

          <nav className="space-y-1 -mx-6">
            <Link href="/" className={navItem(location === "/")} data-testid="nav-home">
              <LayoutDashboard className="w-4 h-4" />
              Dashboard
            </Link>
            <Link href="/new" className={navItem(location === "/new")} data-testid="nav-new">
              <Plus className="w-4 h-4" />
              New Proposal
            </Link>
            <Link
              href="/tenders"
              className={navItem(location.startsWith("/tenders"))}
              data-testid="nav-tenders"
            >
              <Briefcase className="w-4 h-4" />
              Tenders
            </Link>
          </nav>

          <div className="mt-auto pt-8 border-t border-[#222222]">
            <GoogleConnect />
          </div>
        </div>
      </aside>
      <main className="flex-1 overflow-auto bg-black">{children}</main>
    </div>
  );
}
