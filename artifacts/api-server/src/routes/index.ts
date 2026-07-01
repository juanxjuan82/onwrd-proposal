import { Router, type IRouter } from "express";
import healthRouter from "./health";
import proposalsRouter from "./proposals";
import tendersRouter from "./tenders";
import extractTextRouter from "./extract-text";
import authRouter from "./auth";

const router: IRouter = Router();

router.use(healthRouter);
router.use(proposalsRouter);
router.use(tendersRouter);
router.use(extractTextRouter);
router.use(authRouter);

export default router;
