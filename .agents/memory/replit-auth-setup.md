---
name: App authentication architecture
description: Durable decisions behind the deny-by-default auth guard and Replit Auth wiring
---

- App auth is Replit Auth (OIDC); Google OAuth in the codebase is ONLY for Drive export and must coexist — never replace it.
- The /api surface is deny-by-default: routes require auth unless on an explicit public allowlist (health, auth flows, Google callback, public intake POSTs). A standing route-enumeration test walks the live Express router so new routes are covered automatically.
- **Why:** an adversarial report showed every route open; allowlisting protected routes one-by-one invariably misses new ones.
- **How to apply:** new public endpoints must be added deliberately to the allowlist and the standing test's expectations.
- Origin handling is fail-closed: OIDC redirect origins and credentialed CORS origins come only from configured public domains; request Host/X-Forwarded-Host are never trusted, and production refuses to build redirect URLs when no origin is configured.
- Postgres: `ON CONFLICT (col)` cannot use a PARTIAL unique index — upsert targets need a full unique constraint.
