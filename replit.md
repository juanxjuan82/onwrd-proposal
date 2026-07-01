# Workspace

## Overview

pnpm workspace monorepo using TypeScript. Each package manages its own dependencies.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **Database**: PostgreSQL + Drizzle ORM
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec)
- **Build**: esbuild (CJS bundle)
- **AI**: Replit AI Integrations (OpenAI proxy, gpt-5.2) — no user API key required
- **Google Docs**: Google Docs connector (googleapis) via Replit OAuth

## Applications

### Proposal Generator (artifacts/proposal-generator)
- React + Vite frontend at `/`
- Allows ONWRD team to upload project briefs, AI-generate proposals, edit them, and export to Google Docs
- Uses Replit AI Integrations (OpenAI) to parse brief and fill ONWRD proposal template
- Google Docs OAuth via Replit connector

### API Server (artifacts/api-server)
- Express 5 backend at `/api`
- Routes: `/api/proposals` (CRUD), `/api/proposals/parse-brief` (AI), `/api/proposals/:id/export-to-google-docs`
- Depends on: @workspace/db, @workspace/api-zod, @workspace/integrations-openai-ai-server, googleapis

## Key Commands

- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- `pnpm --filter @workspace/api-server run dev` — run API server locally

## Database Schema

### tenders
Bahamas marketing tender database. Stores opportunities (title, agency, description, category, deadline, value, source URL, contact info). Each tender is auto-scored against marketing keywords (`recommendationScore`); tenders with score > 0 appear in the **Recommended** tab.

Key flows:
- **Browse**: `/tenders` page with Recommended/All tabs
- **Add manually**: Dialog from the Tenders page
- **Bulk import**: Paste CSV (columns: `title,agency,description` required; `category,deadline,value_amount,source_url,contact_info` optional)
- **Generate proposal**: From the tender detail page, one click creates a draft proposal (clientName = agency, industry = category, briefText = synthesized from tender). AI fills in the proposal content asynchronously and the user is redirected to the proposal detail page.
- Tender ↔ proposal link via `tenders.proposalId`.

### proposals
- id (serial PK)
- client_name (text)
- industry (text)
- status (text: "draft" | "exported")
- brief_text (text)
- proposal_content (text)
- google_doc_url (text, nullable)
- created_at (timestamp)
- updated_at (timestamp)

## Environment Variables
- `DATABASE_URL` — PostgreSQL connection string (auto-provisioned)
- `AI_INTEGRATIONS_OPENAI_BASE_URL` — Replit AI Integrations proxy URL (auto-set)
- `AI_INTEGRATIONS_OPENAI_API_KEY` — Dummy key for SDK compatibility (auto-set)
- `REPLIT_CONNECTORS_HOSTNAME` — For Google Docs OAuth connector
- `REPL_IDENTITY` — For Google Docs OAuth connector

See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details.
