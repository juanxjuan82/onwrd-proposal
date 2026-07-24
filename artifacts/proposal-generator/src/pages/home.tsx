import { useState } from "react";
import { isTeamReview } from "@/lib/proposal-predicates";
import { useListProposals } from "@workspace/api-client-react";
import { Link } from "wouter";
import { format } from "date-fns";
import {
  FileText,
  Plus,
  ChevronRight,
  Copy,
  Check,
  ExternalLink,
  ChevronDown,
  Share2,
  Clock,
  Send,
  Users,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";

// ── Types ────────────────────────────────────────────────────────────────────
interface Proposal {
  id: number;
  clientName: string;
  industry: string;
  status: string;
  proposalContent?: string | null;
  syncStatus?: string | null;
  googleDocUrl?: string | null;
  googleFileId?: string | null;
  createdAt: string;
  updatedAt?: string;
  tenderId?: number | null;
}

// ── Lifecycle predicates ─────────────────────────────────────────────────────
export { isTeamReview };

function isReadyToShare(p: Proposal): boolean {
  if (isTeamReview(p)) return false;
  return (p.proposalContent?.trim().length ?? 0) > 50 && !p.googleFileId;
}

function isInProgress(p: Proposal): boolean {
  return !isTeamReview(p) && !isReadyToShare(p);
}

type TabKey = "in_progress" | "ready_to_share" | "team_review";

const TABS: { key: TabKey; label: string; icon: React.ReactNode; predicate: (p: Proposal) => boolean }[] = [
  { key: "in_progress",   label: "In Progress",     icon: <Clock className="w-3.5 h-3.5" />,  predicate: isInProgress },
  { key: "ready_to_share", label: "Ready to Share", icon: <Send className="w-3.5 h-3.5" />,   predicate: isReadyToShare },
  { key: "team_review",   label: "Team Review",     icon: <Users className="w-3.5 h-3.5" />,  predicate: isTeamReview },
];

// ── Status badge ─────────────────────────────────────────────────────────────
function ProposalStatusBadge({ p }: { p: Proposal }) {
  if (p.syncStatus === "handoff_complete")
    return <Badge variant="success" className="text-xs font-normal">Handed Off</Badge>;
  if (p.googleDocUrl)
    return <Badge variant="secondary" className="text-xs font-normal">In Google Docs</Badge>;
  if (p.status === "exported")
    return <Badge variant="success" className="text-xs font-normal">Exported</Badge>;
  if (p.status === "draft" && (p.proposalContent?.trim().length ?? 0) > 50)
    return <Badge variant="secondary" className="text-xs font-normal">Draft</Badge>;
  return <Badge variant="outline" className="text-xs font-normal text-muted-foreground">New</Badge>;
}

// ── Intake share card ─────────────────────────────────────────────────────────
function IntakeShareCard() {
  const [copied, setCopied] = useState(false);
  const [open, setOpen] = useState(true);
  const { toast } = useToast();

  const intakeUrl = `${window.location.origin}${import.meta.env.BASE_URL}intake`;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(intakeUrl);
      setCopied(true);
      toast({ title: "Link copied", description: "Send it to your client." });
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast({ title: "Could not copy", variant: "destructive" });
    }
  };

  const share = async () => {
    if (navigator.share) {
      try {
        await navigator.share({
          title: "ONWRD — Project Brief Intake",
          text: "Tell us about your project so we can prepare a proposal.",
          url: intakeUrl,
        });
      } catch { /* user cancelled */ }
    } else {
      copy();
    }
  };

  return (
    <div className="mb-6 border rounded-lg bg-card overflow-hidden" data-testid="card-intake-share">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between p-4 hover:bg-muted/50 transition-colors"
        data-testid="button-toggle-intake"
      >
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-md bg-primary/10 flex items-center justify-center">
            <Share2 className="w-4 h-4 text-primary" />
          </div>
          <div className="text-left">
            <p className="text-sm font-medium text-foreground">Client Intake Form</p>
            <p className="text-xs text-muted-foreground">
              Share this link with prospective clients to collect project briefs.
            </p>
          </div>
        </div>
        <ChevronDown
          className={`w-4 h-4 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>

      {open && (
        <div className="px-4 pb-4 space-y-3 border-t pt-4">
          <div className="flex items-center gap-2">
            <code
              className="flex-1 text-xs font-mono bg-muted px-3 py-2 rounded-md truncate"
              data-testid="text-intake-url"
            >
              {intakeUrl}
            </code>
            <Button
              variant="outline"
              size="sm"
              onClick={copy}
              data-testid="button-copy-intake"
              className="flex-shrink-0"
            >
              {copied ? (
                <><Check className="w-3.5 h-3.5 mr-1" /> Copied</>
              ) : (
                <><Copy className="w-3.5 h-3.5 mr-1" /> Copy</>
              )}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={share}
              data-testid="button-share-intake"
              className="flex-shrink-0"
            >
              <Share2 className="w-3.5 h-3.5 mr-1" /> Share
            </Button>
          </div>

          <div className="rounded-md border overflow-hidden bg-background">
            <div className="flex items-center justify-between px-3 py-2 border-b bg-muted/40">
              <p className="text-xs text-muted-foreground">Live preview</p>
              <a
                href={intakeUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                data-testid="link-open-intake"
              >
                Open in new tab <ExternalLink className="w-3 h-3" />
              </a>
            </div>
            <iframe
              src={intakeUrl}
              title="Client Intake Preview"
              className="w-full h-[500px] bg-black"
              data-testid="iframe-intake-preview"
            />
          </div>
        </div>
      )}
    </div>
  );
}

// ── Proposal card ─────────────────────────────────────────────────────────────
function ProposalCard({ proposal }: { proposal: Proposal }) {
  const teamReview = isTeamReview(proposal);
  const docUrl = proposal.googleDocUrl;
  if (teamReview && docUrl) {
    return (
      <a
        href={docUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="block group"
        data-testid={`link-proposal-${proposal.id}`}
      >
        <div className="p-5 border bg-card rounded-lg hover:border-primary/50 transition-colors flex items-center justify-between gap-4">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2.5 mb-1.5 flex-wrap">
              <h2 className="text-base font-medium text-foreground group-hover:text-primary transition-colors truncate">
                {proposal.clientName}
              </h2>
              <Badge variant="secondary" className="font-normal text-xs shrink-0">
                {proposal.industry}
              </Badge>
              <ProposalStatusBadge p={proposal} />
            </div>
            <p className="text-xs text-muted-foreground">
              {proposal.updatedAt
                ? `Updated ${format(new Date(proposal.updatedAt), "MMM d, yyyy")}`
                : `Created ${format(new Date(proposal.createdAt), "MMM d, yyyy")}`}
            </p>
          </div>
          <ExternalLink className="w-4 h-4 text-muted-foreground group-hover:text-primary transition-colors shrink-0" />
        </div>
      </a>
    );
  }
  return (
    <Link
      href={`/proposals/${proposal.id}`}
      className="block group"
      data-testid={`link-proposal-${proposal.id}`}
    >
      <div className="p-5 border bg-card rounded-lg hover:border-primary/50 transition-colors flex items-center justify-between gap-4">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2.5 mb-1.5 flex-wrap">
            <h2 className="text-base font-medium text-foreground group-hover:text-primary transition-colors truncate">
              {proposal.clientName}
            </h2>
            <Badge variant="secondary" className="font-normal text-xs shrink-0">
              {proposal.industry}
            </Badge>
            <ProposalStatusBadge p={proposal} />
          </div>
          <p className="text-xs text-muted-foreground">
            {proposal.updatedAt
              ? `Updated ${format(new Date(proposal.updatedAt), "MMM d, yyyy")}`
              : `Created ${format(new Date(proposal.createdAt), "MMM d, yyyy")}`}
          </p>
        </div>
        <ChevronRight className="w-4 h-4 text-muted-foreground group-hover:text-primary transition-colors shrink-0" />
      </div>
    </Link>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────
export default function Home() {
  const { data: rawProposals, isLoading } = useListProposals();
  const proposals = (rawProposals ?? []) as Proposal[];

  const [activeTab, setActiveTab] = useState<TabKey>("in_progress");

  const tabCounts = Object.fromEntries(
    TABS.map((t) => [t.key, proposals.filter(t.predicate).length]),
  ) as Record<TabKey, number>;

  const visible = proposals.filter(TABS.find((t) => t.key === activeTab)!.predicate);

  return (
    <div className="p-8 max-w-5xl mx-auto">
      {/* Header */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center mb-8 gap-4">
        <div>
          <h1 className="text-3xl font-bold text-white mb-1 tracking-tight">Proposals</h1>
          <p className="text-muted-foreground text-sm">Manage and generate client proposals.</p>
        </div>
        <Button asChild data-testid="button-create-new">
          <Link href="/new" className="flex items-center gap-2">
            <Plus className="w-4 h-4" />
            New Proposal
          </Link>
        </Button>
      </div>

      <IntakeShareCard />

      {/* Lifecycle tabs */}
      <div className="flex gap-1 mb-5 border-b pb-0">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setActiveTab(t.key)}
            className={`flex items-center gap-1.5 px-3 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
              activeTab === t.key
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            {t.icon}
            {t.label}
            {tabCounts[t.key] > 0 && (
              <span className={`ml-1 rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${
                activeTab === t.key
                  ? "bg-primary/20 text-primary"
                  : "bg-muted text-muted-foreground"
              }`}>
                {tabCounts[t.key]}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Content */}
      {isLoading ? (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-20 w-full rounded-lg" />
          ))}
        </div>
      ) : visible.length === 0 ? (
        <div className="text-center py-14 px-4 border border-dashed rounded-lg bg-card/50">
          <div className="w-10 h-10 bg-primary/10 rounded-full flex items-center justify-center mx-auto mb-3">
            <FileText className="w-5 h-5 text-primary" />
          </div>
          {proposals.length === 0 ? (
            <>
              <h3 className="text-base font-medium text-foreground mb-2">No proposals yet</h3>
              <p className="text-muted-foreground text-sm mb-5 max-w-sm mx-auto">
                Get started by generating your first client proposal from a project brief.
              </p>
              <Button asChild variant="outline" data-testid="button-empty-create">
                <Link href="/new">Create Proposal</Link>
              </Button>
            </>
          ) : (
            <>
              <h3 className="text-base font-medium text-foreground mb-1">
                No proposals in this stage
              </h3>
              <p className="text-muted-foreground text-sm">
                {activeTab === "ready_to_share"
                  ? "Proposals with content will appear here when ready to export."
                  : activeTab === "team_review"
                  ? "Proposals shared to Google Docs will appear here."
                  : "Proposals you're working on will appear here."}
              </p>
            </>
          )}
        </div>
      ) : (
        <div className="grid gap-3">
          {visible.map((proposal) => (
            <ProposalCard key={proposal.id} proposal={proposal} />
          ))}
        </div>
      )}
    </div>
  );
}
