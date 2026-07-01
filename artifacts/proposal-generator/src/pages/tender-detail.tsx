import { useParams, useLocation, Link } from "wouter";
import { format } from "date-fns";
import { ArrowLeft, Sparkles, ExternalLink, Loader2, FileText } from "lucide-react";
import {
  useGetTender,
  useGenerateProposalFromTender,
  getListTendersQueryKey,
  getGetTenderQueryKey,
  getListProposalsQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";

export default function TenderDetail() {
  const { id } = useParams<{ id: string }>();
  const tenderId = Number(id);
  const [, setLocation] = useLocation();
  const { data: tender, isLoading } = useGetTender(tenderId);
  const generate = useGenerateProposalFromTender();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const handleGenerate = async () => {
    try {
      const proposal = await generate.mutateAsync({ id: tenderId });
      queryClient.invalidateQueries({ queryKey: getListTendersQueryKey() });
      queryClient.invalidateQueries({ queryKey: getGetTenderQueryKey(tenderId) });
      queryClient.invalidateQueries({ queryKey: getListProposalsQueryKey() });
      toast({
        title: "Proposal draft started",
        description: "AI is generating the proposal in the background. Refresh in ~30 seconds.",
      });
      setLocation(`/proposals/${proposal.id}`);
    } catch (e) {
      toast({ title: "Generation failed", description: String(e), variant: "destructive" });
    }
  };

  if (isLoading) {
    return (
      <div className="p-8 max-w-4xl mx-auto">
        <Skeleton className="h-8 w-32 mb-6" />
        <Skeleton className="h-10 w-3/4 mb-4" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (!tender) {
    return (
      <div className="p-8 max-w-4xl mx-auto">
        <Link href="/tenders" className="text-sm text-muted-foreground hover:text-foreground inline-flex items-center gap-1 mb-4">
          <ArrowLeft className="w-4 h-4" /> Back to Tenders
        </Link>
        <p>Tender not found.</p>
      </div>
    );
  }

  return (
    <div className="p-8 max-w-4xl mx-auto">
      <Link
        href="/tenders"
        className="text-sm text-muted-foreground hover:text-foreground inline-flex items-center gap-1 mb-6"
        data-testid="link-back"
      >
        <ArrowLeft className="w-4 h-4" /> Back to Tenders
      </Link>

      <div className="mb-6">
        <div className="flex flex-wrap items-center gap-2 mb-3">
          <Badge variant="secondary">{tender.category}</Badge>
          {tender.recommendationScore > 0 && (
            <Badge variant="destructive">
              <Sparkles className="w-3 h-3 mr-1" /> Recommended
            </Badge>
          )}
          <Badge variant="outline">{tender.status}</Badge>
        </div>
        <h1 className="text-3xl font-bold text-white mb-2 tracking-tight">{tender.title}</h1>
        <p className="text-lg text-foreground">{tender.agency}</p>
      </div>

      <div className="grid sm:grid-cols-3 gap-4 mb-6 p-4 border rounded-lg bg-card">
        {tender.deadline && (
          <div>
            <p className="text-xs uppercase text-muted-foreground mb-1">Deadline</p>
            <p className="text-sm font-medium">{format(new Date(tender.deadline), "MMM d, yyyy")}</p>
          </div>
        )}
        {tender.valueAmount && (
          <div>
            <p className="text-xs uppercase text-muted-foreground mb-1">Estimated Value</p>
            <p className="text-sm font-medium">{tender.valueAmount}</p>
          </div>
        )}
        {tender.contactInfo && (
          <div>
            <p className="text-xs uppercase text-muted-foreground mb-1">Contact</p>
            <p className="text-sm font-medium">{tender.contactInfo}</p>
          </div>
        )}
      </div>

      <div className="mb-8">
        <h2 className="text-lg font-medium mb-2">Scope / Description</h2>
        <div className="p-4 border rounded-lg bg-card whitespace-pre-wrap text-sm text-foreground">
          {tender.description}
        </div>
        {tender.sourceUrl && (
          <a
            href={tender.sourceUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-sm text-primary hover:underline mt-3"
          >
            View original source <ExternalLink className="w-3 h-3" />
          </a>
        )}
      </div>

      <div className="flex flex-wrap gap-3">
        {tender.proposalId ? (
          <Button asChild variant="default" data-testid="button-view-proposal">
            <Link href={`/proposals/${tender.proposalId}`} className="flex items-center gap-2">
              <FileText className="w-4 h-4" /> View Generated Proposal
            </Link>
          </Button>
        ) : (
          <Button
            onClick={handleGenerate}
            disabled={generate.isPending}
            data-testid="button-generate-proposal"
          >
            {generate.isPending ? (
              <>
                <Loader2 className="w-4 h-4 mr-1 animate-spin" /> Generating...
              </>
            ) : (
              <>
                <Sparkles className="w-4 h-4 mr-1" /> Generate Proposal from Tender
              </>
            )}
          </Button>
        )}
      </div>
    </div>
  );
}
