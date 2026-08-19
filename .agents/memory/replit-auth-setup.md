---
name: App authentication architecture
description: Durable decisions behind Google Workspace login and the deny-by-default auth guard
---

- App auth is Google Workspace OAuth only. Login uses the existing Google OAuth callback alongside the separate Drive-authorization flow; the stored OAuth state selects the intended flow. Sessions must be marked `provider: "google"` so pre-migration Replit sessions are rejected.
- **Why:** access is restricted to verified `@onwrdadvisors.com` Google Workspace accounts, while Drive authorization must continue to work without a second callback registration.
- **How to apply:** keep the exact email-domain check server-side after Google userinfo retrieval; use the Workspace `hd` parameter only as an account-selection hint. Any new session provider must be explicit and rejected unless intentionally supported.
- The /api surface is deny-by-default: routes require auth unless on an explicit public allowlist (health, auth flows, Google callback, public intake POSTs). A standing route-enumeration test walks the live Express router so new routes are covered automatically.
- **Why:** an adversarial report showed every route open; allowlisting protected routes one-by-one invariably misses new ones.
- **How to apply:** new public endpoints must be added deliberately to the allowlist and the standing test's expectations.
- Google callback URLs and credentialed CORS origins come only from configured public domains; request Host/X-Forwarded-Host are never trusted.
- Postgres: `ON CONFLICT (col)` cannot use a PARTIAL unique index — upsert targets need a full unique constraint.
