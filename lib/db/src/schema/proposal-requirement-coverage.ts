import {
  pgTable,
  text,
  serial,
  timestamp,
  integer,
  unique,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

import { proposalsTable } from "./proposals";
import { proposalSectionsTable } from "./proposal-sections";
import { tenderRequirementsTable } from "./tender-requirements";

export const proposalRequirementCoverageTable = pgTable(
  "proposal_requirement_coverage",
  {
    id: serial("id").primaryKey(),
    proposalId: integer("proposal_id")
      .notNull()
      .references(() => proposalsTable.id, { onDelete: "cascade" }),
    requirementId: integer("requirement_id")
      .notNull()
      .references(() => tenderRequirementsTable.id, { onDelete: "cascade" }),
    mappedSectionId: integer("mapped_section_id").references(
      () => proposalSectionsTable.id,
      { onDelete: "set null" },
    ),
    status: text("status").notNull().default("unanswered"),
    confidence: integer("confidence").notNull().default(0),
    reviewReason: text("review_reason"),
    evidenceReferences: text("evidence_references").notNull().default("[]"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    unique("proposal_requirement_coverage_proposal_requirement_unique").on(
      t.proposalId,
      t.requirementId,
    ),
  ],
);

export const insertProposalRequirementCoverageSchema = createInsertSchema(
  proposalRequirementCoverageTable,
).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertProposalRequirementCoverage = z.infer<
  typeof insertProposalRequirementCoverageSchema
>;
export type ProposalRequirementCoverage =
  typeof proposalRequirementCoverageTable.$inferSelect;