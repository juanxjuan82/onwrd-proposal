import { useRoute, useLocation } from "wouter";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { 
  useGetProposal, 
  useUpdateProposal, 
  useDeleteProposal,
  useExportToGoogleDocs,
  getGetProposalQueryKey,
  getListProposalsQueryKey
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { ExternalLink, Loader2, ArrowLeft, Trash2, CheckCircle2, Eye, Pencil } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { useEffect, useRef, useState } from "react";

const proposalSchema = z.object({
  clientName: z.string().min(1, "Client name is required"),
  industry: z.string().min(1, "Industry is required"),
  proposalContent: z.string().min(1, "Proposal content is required"),
});

type ProposalFormValues = z.infer<typeof proposalSchema>;

export default function ProposalDetail() {
  const [, params] = useRoute("/proposals/:id");
  const id = Number(params?.id);
  const [, setLocation] = useLocation();
  const [previewMode, setPreviewMode] = useState(false);
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: proposal, isLoading } = useGetProposal(id);
  const updateProposal = useUpdateProposal();
  const deleteProposal = useDeleteProposal();
  const exportToDocs = useExportToGoogleDocs();

  const form = useForm<ProposalFormValues>({
    resolver: zodResolver(proposalSchema),
    defaultValues: {
      clientName: "",
      industry: "",
      proposalContent: "",
    }
  });

  const initializedRef = useRef(false);

  useEffect(() => {
    if (proposal && !initializedRef.current) {
      form.reset({
        clientName: proposal.clientName,
        industry: proposal.industry,
        proposalContent: proposal.proposalContent,
      });
      initializedRef.current = true;
    }
  }, [proposal, form]);

  const handleSave = (values: ProposalFormValues) => {
    updateProposal.mutate({
      id,
      data: values
    }, {
      onSuccess: (data) => {
        queryClient.setQueryData(getGetProposalQueryKey(id), data);
        queryClient.invalidateQueries({ queryKey: getListProposalsQueryKey() });
        toast({
          title: "Saved",
          description: "Changes saved successfully.",
        });
      },
      onError: (error) => {
        toast({
          title: "Save failed",
          description: error.error || "Could not save changes.",
          variant: "destructive"
        });
      }
    });
  };

  const handleExport = () => {
    exportToDocs.mutate({ id }, {
      onSuccess: (data) => {
        queryClient.invalidateQueries({ queryKey: getGetProposalQueryKey(id) });
        queryClient.invalidateQueries({ queryKey: getListProposalsQueryKey() });
        toast({
          title: "Exported successfully",
          description: (
            <div className="flex flex-col gap-2 mt-2">
              <p>Document created in Google Docs.</p>
              <Button variant="outline" size="sm" asChild className="w-fit">
                <a href={data.docUrl} target="_blank" rel="noopener noreferrer" className="flex items-center gap-2">
                  <ExternalLink className="w-4 h-4" />
                  Open Document
                </a>
              </Button>
            </div>
          ),
          duration: 10000,
        });
      },
      onError: (error) => {
        toast({
          title: "Export failed",
          description: error.error || "Could not export to Google Docs.",
          variant: "destructive"
        });
      }
    });
  };

  const handleDelete = () => {
    deleteProposal.mutate({ id }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListProposalsQueryKey() });
        toast({
          title: "Deleted",
          description: "Proposal has been deleted.",
        });
        setLocation("/");
      },
      onError: (error) => {
        toast({
          title: "Delete failed",
          description: error.error || "Could not delete proposal.",
          variant: "destructive"
        });
      }
    });
  };

  if (isLoading) {
    return (
      <div className="p-8 max-w-5xl mx-auto space-y-6">
        <Skeleton className="h-8 w-32" />
        <Skeleton className="h-12 w-2/3" />
        <div className="grid grid-cols-2 gap-6">
          <Skeleton className="h-20" />
          <Skeleton className="h-20" />
        </div>
        <Skeleton className="h-[600px] w-full" />
      </div>
    );
  }

  if (!proposal) {
    return (
      <div className="p-8 max-w-5xl mx-auto text-center py-20">
        <h2 className="text-2xl font-semibold mb-4">Proposal not found</h2>
        <Button onClick={() => setLocation("/")} variant="outline">
          Return to Dashboard
        </Button>
      </div>
    );
  }

  return (
    <div className="p-8 max-w-5xl mx-auto">
      <div className="mb-6 flex items-center gap-4">
        <Button variant="ghost" size="sm" onClick={() => setLocation("/")} className="gap-2">
          <ArrowLeft className="w-4 h-4" />
          Back
        </Button>
        <Badge variant={proposal.status === "exported" ? "success" : "default"}>
          {proposal.status === "exported" ? "Exported" : "Draft"}
        </Badge>
      </div>

      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-8">
        <h1 className="text-4xl font-bold text-white tracking-tight">
          Edit Proposal
        </h1>
        <div className="flex items-center gap-3">
          {proposal.googleDocUrl && (
            <Button variant="outline" asChild data-testid="button-open-doc">
              <a href={proposal.googleDocUrl} target="_blank" rel="noopener noreferrer" className="gap-2">
                <ExternalLink className="w-4 h-4" />
                Open Doc
              </a>
            </Button>
          )}
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="destructive" size="icon" data-testid="button-delete">
                <Trash2 className="w-4 h-4" />
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Are you sure?</AlertDialogTitle>
                <AlertDialogDescription>
                  This action cannot be undone. This will permanently delete the proposal from the system.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction 
                  onClick={handleDelete} 
                  className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  data-testid="button-confirm-delete"
                >
                  Delete
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </div>

      <Form {...form}>
        <form className="space-y-6" onSubmit={form.handleSubmit(handleSave)}>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6 bg-card p-6 border rounded-lg">
            <FormField
              control={form.control}
              name="clientName"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Client Name</FormLabel>
                  <FormControl>
                    <Input {...field} data-testid="input-client-name" />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="industry"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Industry</FormLabel>
                  <FormControl>
                    <Input {...field} data-testid="input-industry" />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>

          {proposal.briefText && (
            <div className="bg-card border rounded-lg overflow-hidden">
              <div className="bg-muted p-4 border-b">
                <Label className="font-semibold text-foreground">Client Brief</Label>
                <p className="text-xs text-muted-foreground mt-0.5">Original intake form submission — read only</p>
              </div>
              <pre className="p-6 text-sm text-muted-foreground whitespace-pre-wrap font-sans leading-relaxed">
                {proposal.briefText}
              </pre>
            </div>
          )}

          <div className="bg-card border rounded-lg overflow-hidden flex flex-col">
            <div className="bg-muted p-4 border-b flex items-center justify-between">
              <Label className="font-semibold text-foreground">Document Content</Label>
              <div className="flex items-center gap-3">
                <div className="flex rounded-md border overflow-hidden text-sm">
                  <button
                    type="button"
                    onClick={() => setPreviewMode(false)}
                    className={`flex items-center gap-1.5 px-3 py-1.5 transition-colors ${
                      !previewMode
                        ? "bg-primary text-primary-foreground"
                        : "bg-background text-muted-foreground hover:bg-accent"
                    }`}
                  >
                    <Pencil className="w-3.5 h-3.5" />
                    Edit
                  </button>
                  <button
                    type="button"
                    onClick={() => setPreviewMode(true)}
                    className={`flex items-center gap-1.5 px-3 py-1.5 transition-colors ${
                      previewMode
                        ? "bg-primary text-primary-foreground"
                        : "bg-background text-muted-foreground hover:bg-accent"
                    }`}
                  >
                    <Eye className="w-3.5 h-3.5" />
                    Preview
                  </button>
                </div>
                <img src="/onwrd-logo-white.png" alt="ONWRD" className="h-7 object-contain" />
              </div>
            </div>
            <FormField
              control={form.control}
              name="proposalContent"
              render={({ field }) => (
                <FormItem className="flex-1 space-y-0">
                  <FormControl>
                    {previewMode ? (
                      <div
                        className="min-h-[600px] p-8 font-sans text-base leading-relaxed prose prose-sm max-w-none
                          [&_table]:w-full [&_table]:border-collapse [&_table]:text-sm
                          [&_th]:border [&_th]:border-border [&_th]:bg-muted [&_th]:px-3 [&_th]:py-2 [&_th]:text-left [&_th]:font-semibold
                          [&_td]:border [&_td]:border-border [&_td]:px-3 [&_td]:py-2 [&_td]:align-top
                          [&_tr:nth-child(even)_td]:bg-muted/30"
                      >
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>
                          {field.value}
                        </ReactMarkdown>
                      </div>
                    ) : (
                      <Textarea
                        {...field}
                        className="min-h-[600px] border-0 focus-visible:ring-0 rounded-none resize-y p-8 font-sans text-base leading-relaxed"
                        data-testid="input-proposal-content"
                      />
                    )}
                  </FormControl>
                  <FormMessage className="px-8 pb-4" />
                </FormItem>
              )}
            />
          </div>

          <div className="flex justify-end gap-4 pt-4">
            <Button 
              type="submit"
              variant="secondary"
              disabled={updateProposal.isPending || exportToDocs.isPending}
              data-testid="button-save"
            >
              {updateProposal.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              Save Changes
            </Button>
            <Button 
              type="button"
              disabled={updateProposal.isPending || exportToDocs.isPending}
              onClick={handleExport}
              className="bg-[#0000FF] hover:bg-[#0000FF] text-white border border-[#0000FF]"
              data-testid="button-export"
            >
              {exportToDocs.isPending ? (
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              ) : (
                <CheckCircle2 className="w-4 h-4 mr-2" />
              )}
              Export to Google Docs
            </Button>
          </div>
        </form>
      </Form>
    </div>
  );
}
