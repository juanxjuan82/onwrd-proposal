import { useState } from "react";
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
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";

function IntakeShareCard() {
  const [copied, setCopied] = useState(false);
  const [open, setOpen] = useState(true);
  const { toast } = useToast();

  // BASE_URL includes a trailing slash for the artifact mount path
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
      } catch {
        /* user cancelled */
      }
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
                <>
                  <Check className="w-3.5 h-3.5 mr-1" /> Copied
                </>
              ) : (
                <>
                  <Copy className="w-3.5 h-3.5 mr-1" /> Copy
                </>
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

export default function Home() {
  const { data: proposals, isLoading } = useListProposals();

  return (
    <div className="p-8 max-w-6xl mx-auto">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center mb-8 gap-4">
        <div>
          <h1 className="text-4xl font-bold text-white mb-2 tracking-tight">Proposals</h1>
          <p className="text-muted-foreground">Manage and generate client proposals.</p>
        </div>
        <Button asChild data-testid="button-create-new">
          <Link href="/new" className="flex items-center gap-2">
            <Plus className="w-4 h-4" />
            New Proposal
          </Link>
        </Button>
      </div>

      <IntakeShareCard />

      {isLoading ? (
        <div className="space-y-4">
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-24 w-full rounded-lg" />
          ))}
        </div>
      ) : proposals?.length === 0 ? (
        <div className="text-center py-16 px-4 border border-dashed rounded-lg bg-card/50">
          <div className="w-12 h-12 bg-primary/10 rounded-full flex items-center justify-center mx-auto mb-4">
            <FileText className="w-6 h-6 text-primary" />
          </div>
          <h3 className="text-lg font-medium text-foreground mb-2">No proposals yet</h3>
          <p className="text-muted-foreground mb-6 max-w-sm mx-auto">
            Get started by generating your first client proposal from a project brief.
          </p>
          <Button asChild variant="outline" data-testid="button-empty-create">
            <Link href="/new">Create Proposal</Link>
          </Button>
        </div>
      ) : (
        <div className="grid gap-4">
          {proposals?.map((proposal) => (
            <Link 
              key={proposal.id} 
              href={`/proposals/${proposal.id}`}
              className="block group"
              data-testid={`link-proposal-${proposal.id}`}
            >
              <div className="p-6 border bg-card rounded-lg hover:border-primary/50 transition-colors flex items-center justify-between">
                <div className="flex-1">
                  <div className="flex items-center gap-3 mb-2">
                    <h2 className="text-xl font-medium text-foreground group-hover:text-primary transition-colors">
                      {proposal.clientName}
                    </h2>
                    <Badge variant="secondary" className="font-normal text-xs">
                      {proposal.industry}
                    </Badge>
                    {proposal.status === "new" && (
                      <Badge variant="default" className="animate-pulse">
                        New
                      </Badge>
                    )}
                    {proposal.status === "exported" && (
                      <Badge variant="success">
                        Exported
                      </Badge>
                    )}
                    {proposal.status === "draft" && (
                      <Badge variant="secondary">Draft</Badge>
                    )}
                  </div>
                  <p className="text-sm text-muted-foreground">
                    Created {format(new Date(proposal.createdAt), "MMM d, yyyy")}
                  </p>
                </div>
                <div className="text-muted-foreground group-hover:text-primary transition-colors">
                  <ChevronRight className="w-5 h-5" />
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
