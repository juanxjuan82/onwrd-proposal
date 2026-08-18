import express, { type Express } from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import pinoHttp from "pino-http";
import session from "express-session";
import { authMiddleware } from "./middlewares/authMiddleware";
import connectPgSimple from "connect-pg-simple";
import { pool } from "@workspace/db";
import router from "./routes";
import { logger } from "./lib/logger";

declare module "express-session" {
  interface SessionData {
    googleAccessToken?: string;
    googleRefreshToken?: string;
    googleTokenExpiry?: number;
    googleUserEmail?: string;
    googleOAuthState?: string;
    googleOAuthReturnTo?: string;
  }
}

const isProd = process.env.NODE_ENV === "production";

const sessionSecret = process.env.SESSION_SECRET;
if (!sessionSecret) {
  if (isProd) {
    throw new Error("SESSION_SECRET environment variable is required in production");
  } else {
    logger.warn("SESSION_SECRET is not set — using insecure fallback (development only)");
  }
}

// Awaited startup migrations + session DDL.  The server does not begin
// listening until this promise resolves, so every column added here is
// guaranteed to exist before the first request is served.
export const dbReady: Promise<void> = pool
  // ── Idempotent schema migrations ─────────────────────────────────────────
  .query(`ALTER TABLE proposals ADD COLUMN IF NOT EXISTS handoff_started_at TIMESTAMP`)
  .then(() => pool.query(`ALTER TABLE proposals ADD COLUMN IF NOT EXISTS generation_status TEXT`))
  // ── Session table ─────────────────────────────────────────────────────────
  .then(() =>
    pool.query(
      `CREATE TABLE IF NOT EXISTS session (
        sid varchar NOT NULL,
        sess json NOT NULL,
        expire timestamp(6) NOT NULL,
        CONSTRAINT session_pkey PRIMARY KEY (sid)
      )`,
    ),
  )
  .then(() => pool.query(`CREATE INDEX IF NOT EXISTS IDX_session_expire ON session (expire)`))
  // ── Replit Auth tables (app authentication) ──────────────────────────────
  .then(() =>
    pool.query(
      `CREATE TABLE IF NOT EXISTS sessions (
        sid varchar PRIMARY KEY,
        sess jsonb NOT NULL,
        expire timestamp NOT NULL
      )`,
    ),
  )
  .then(() => pool.query(`CREATE INDEX IF NOT EXISTS "IDX_sessions_expire" ON sessions (expire)`))
  .then(() =>
    pool.query(
      `CREATE TABLE IF NOT EXISTS users (
        id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        email varchar UNIQUE,
        first_name varchar,
        last_name varchar,
        profile_image_url varchar,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )`,
    ),
  )
  // ── Prompt-injection defence columns (Layer 2/3 flags) ────────────────────
  .then(() =>
    pool.query(
      `ALTER TABLE proposals
         ADD COLUMN IF NOT EXISTS review_required boolean NOT NULL DEFAULT false,
         ADD COLUMN IF NOT EXISTS flagged_phrases text[] NOT NULL DEFAULT '{}',
         ADD COLUMN IF NOT EXISTS unverified_credentials text[] NOT NULL DEFAULT '{}'`,
    ),
  )
  .then(() =>
    pool.query(
      `ALTER TABLE tenders
         ADD COLUMN IF NOT EXISTS injection_warning boolean NOT NULL DEFAULT false`,
    ),
  )
  // intake_drafts upsert relies on ON CONFLICT (submission_key), which needs a
  // full (non-partial) unique constraint.
  .then(() =>
    pool.query(
      `DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'intake_drafts_submission_key_unique'
        ) THEN
          ALTER TABLE intake_drafts ADD CONSTRAINT intake_drafts_submission_key_unique UNIQUE (submission_key);
        END IF;
      END $$`,
    ),
  )
  .then(() => undefined)
  .catch((err: unknown) => {
    const reason = err instanceof Error ? err.message : String(err);
    logger.error({ reason }, "Startup migration / session-store initialization failed — refusing to start");
    throw err;
  });

const PgStore = connectPgSimple(session);

const app: Express = express();

app.set("trust proxy", 1);

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
/**
 * Credentialed CORS must never reflect arbitrary origins. Only the app's own
 * configured public origins are allowed; requests without an Origin header
 * (same-origin, curl, server-to-server) pass through untouched.
 */
export function getAllowedOrigins(): Set<string> {
  const origins = new Set<string>();
  for (const d of (process.env.REPLIT_DOMAINS ?? "").split(",")) {
    const t = d.trim();
    if (t) origins.add(`https://${t}`);
  }
  if (process.env.REPLIT_DEV_DOMAIN) {
    origins.add(`https://${process.env.REPLIT_DEV_DOMAIN}`);
  }
  if (process.env.APP_ORIGIN) origins.add(process.env.APP_ORIGIN);
  if (!isProd) {
    origins.add("http://localhost:80");
    origins.add("http://127.0.0.1:80");
    origins.add("http://localhost:3000");
  }
  return origins;
}

app.use(
  cors({
    credentials: true,
    origin: (origin, callback) => {
      if (!origin) {
        callback(null, true);
        return;
      }
      callback(null, getAllowedOrigins().has(origin));
    },
  }),
);
app.use(cookieParser());
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

app.use(
  session({
    store: new PgStore({
      pool,
      createTableIfMissing: true,
    }),
    secret: sessionSecret ?? "fallback-dev-secret-do-not-use-in-prod",
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: isProd,
      maxAge: 7 * 24 * 60 * 60 * 1000,
    },
  }),
);

app.use(authMiddleware);

app.use("/api", router);

export default app;
