import { Router, type IRouter } from "express";
import healthRouter from "./health";
import proposalsRouter from "./proposals";
import tendersRouter from "./tenders";
import extractTextRouter from "./extract-text";
import authRouter from "./auth";
import opportunitiesRouter from "./opportunities";
import sectionsRouter from "./sections";
import knowledgeRouter from "./knowledge";
import tenderIntelligenceRouter from "./tender-intelligence";
import driveConfigRouter from "./drive-config";
import adminRouter from "./admin";
import {
  aiRouteLimiter,
  globalApiLimiter,
  intakeLimiter,
  requireAuth,
} from "../middlewares/apiGuard";

const router: IRouter = Router();

// ── Global rate limit on every /api route ────────────────────────────────────
router.use(globalApiLimiter);

// ── Stricter limit on public intake submissions ─────────────────────────────
router.post("/intake", intakeLimiter);

// ── Deny-by-default auth guard (explicit public allowlist in apiGuard.ts) ───
router.use(requireAuth);

// ── Per-session limit on AI-invoking routes ─────────────────────────────────
router.use(aiRouteLimiter);

router.use(healthRouter);
router.use(proposalsRouter);
router.use(tendersRouter);
router.use(extractTextRouter);
router.use(authRouter);
router.use(opportunitiesRouter);
router.use(sectionsRouter);
router.use(knowledgeRouter);
router.use(tenderIntelligenceRouter);
router.use(driveConfigRouter);
router.use("/admin", adminRouter);

export default router;
