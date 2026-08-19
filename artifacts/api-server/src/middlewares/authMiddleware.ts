import type { AuthUser } from '@workspace/api-zod';
import { type NextFunction, type Request, type Response } from 'express';

import {
  clearSession,
  getSession,
  getSessionId,
  isAllowedEmail,
  refreshGoogleSession,
  type SessionData,
} from '../lib/auth';

declare global {
  namespace Express {
    interface User extends AuthUser {}

    interface Request {
      isAuthenticated(): this is AuthedRequest;

      user?: User | undefined;
    }

    export interface AuthedRequest {
      user: User;
    }
  }
}

export async function authMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  req.isAuthenticated = function (this: Request) {
    return this.user != null;
  } as Request['isAuthenticated'];

  const sid = getSessionId(req);
  if (!sid) {
    next();
    return;
  }

  const session = await getSession(sid);
  if (!session?.user?.id) {
    await clearSession(res, sid);
    next();
    return;
  }

  // Replit sessions created before the Google Workspace migration must not
  // remain valid after the provider switch.
  if (session.provider !== 'google' || !isAllowedEmail(session.user.email)) {
    await clearSession(res, sid);
    next();
    return;
  }

  const refreshed = await refreshGoogleSession(sid, session);
  if (!refreshed) {
    await clearSession(res, sid);
    next();
    return;
  }

  req.user = refreshed.user;
  next();
}
