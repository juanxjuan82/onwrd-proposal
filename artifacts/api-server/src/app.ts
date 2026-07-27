import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import session from "express-session";
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

// Add handoff_started_at column if it doesn't exist (idempotent startup migration)
pool.query(
  `ALTER TABLE proposals ADD COLUMN IF NOT EXISTS handoff_started_at TIMESTAMP`,
).catch((err: unknown) => {
  logger.error({ err }, "Failed to apply handoff_started_at migration");
});

// Add generation_status column if it doesn't exist (idempotent startup migration)
pool.query(
  `ALTER TABLE proposals ADD COLUMN IF NOT EXISTS generation_status TEXT`,
).catch((err: unknown) => {
  logger.error({ err }, "Failed to apply generation_status migration");
});

// Ensure session table exists before accepting requests — connect-pg-simple's
// internal DDL is unreliable at startup; await this in index.ts before listen.
export const dbReady: Promise<void> = pool
  .query(
    `CREATE TABLE IF NOT EXISTS session (
    sid varchar NOT NULL,
    sess json NOT NULL,
    expire timestamp(6) NOT NULL,
    CONSTRAINT session_pkey PRIMARY KEY (sid)
  )`,
  )
  .then(() => pool.query(`CREATE INDEX IF NOT EXISTS IDX_session_expire ON session (expire)`))
  .then(() => undefined)
  .catch((err: unknown) => {
    const reason = err instanceof Error ? err.message : String(err);
    logger.error({ reason }, "Session store initialization failed — refusing to start");
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
app.use(cors({ origin: true, credentials: true }));
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

app.use("/api", router);

export default app;
