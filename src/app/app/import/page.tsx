import { requireUser } from "@/server/lib/require-user";
import { listUserAccounts } from "@/server/actions/active-account";
import { listImportBatchesAction } from "@/server/actions/statement-import";
import { StatementImportPanel } from "@/components/import/StatementImportPanel";

export const metadata = {
  title: "Import statements | RiskGuard",
  description: "Preview and import broker statements into your trading journal.",
};

/**
 * Phase 30.3 — statement/screenshot import. Server component: it only reads
 * the user's own accounts + batches and hands plain serializable data to the
 * client preview UI.
 */
export default async function ImportPage() {
  await requireUser();
  const [accounts, batches] = await Promise.all([listUserAccounts(), listImportBatchesAction()]);

  const recentBatches = batches.map((b) => ({
    id: b.id,
    source: b.source,
    status: b.status,
    fileName: b.fileName,
    committed: b.committed,
    duplicates: b.duplicates,
    errorSummary: b.errorSummary,
    createdAt: b.createdAt.toISOString(),
  }));

  return <StatementImportPanel accounts={accounts} recentBatches={recentBatches} />;
}
