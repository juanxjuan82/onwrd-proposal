import { GoogleConnect } from "@/components/google-connect";
import { Settings, Info } from "lucide-react";

export default function SettingsGoogle() {
  return (
    <div className="p-8 max-w-3xl mx-auto">
      <div className="mb-8">
        <h1 className="text-4xl font-bold text-white mb-2 tracking-tight">Settings</h1>
        <p className="text-muted-foreground">Manage integrations and export configuration.</p>
      </div>

      {/* Google Docs Integration */}
      <div className="space-y-6">
        <section className="space-y-4">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-md bg-primary/10 flex items-center justify-center">
              <Settings className="w-4 h-4 text-primary" />
            </div>
            <h2 className="text-lg font-semibold">Google Docs Integration</h2>
          </div>

          <div className="p-5 rounded-lg border bg-card">
            <p className="text-sm text-muted-foreground mb-4">
              Connect your Google account to export proposals directly to Google Docs. Once connected, approved proposals can be exported to your Google Drive with one click.
            </p>
            <GoogleConnect />
          </div>
        </section>

        <section className="space-y-4">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-md bg-primary/10 flex items-center justify-center">
              <Info className="w-4 h-4 text-primary" />
            </div>
            <h2 className="text-lg font-semibold">Export Behaviour</h2>
          </div>

          <div className="p-5 rounded-lg border bg-card space-y-4 text-sm">
            <div className="flex gap-3">
              <div className="w-2 h-2 rounded-full bg-primary mt-1.5 flex-shrink-0" />
              <div>
                <p className="font-medium mb-0.5">Section-based export</p>
                <p className="text-muted-foreground">When a proposal has been generated from an opportunity with individual sections, the export uses those sections as distinct chapters in the Google Doc.</p>
              </div>
            </div>
            <div className="flex gap-3">
              <div className="w-2 h-2 rounded-full bg-primary mt-1.5 flex-shrink-0" />
              <div>
                <p className="font-medium mb-0.5">Quality gate</p>
                <p className="text-muted-foreground">Proposals with unresolved <code className="bg-muted px-1 rounded text-xs">[NEEDS ONWRD INPUT]</code> placeholders or major critic issues must be approved before export. Use the "Approve for Export" button on the proposal page.</p>
              </div>
            </div>
            <div className="flex gap-3">
              <div className="w-2 h-2 rounded-full bg-primary mt-1.5 flex-shrink-0" />
              <div>
                <p className="font-medium mb-0.5">Intake proposals</p>
                <p className="text-muted-foreground">Proposals generated from the client intake form can be exported at any time from the proposal detail page.</p>
              </div>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
