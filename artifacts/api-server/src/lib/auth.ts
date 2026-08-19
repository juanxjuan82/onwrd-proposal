import crypto from 'crypto';
import type { AuthUser } from '@workspace/api-zod';
import { db, sessionsTable, usersTable } from '@workspace/db';
import { eq } from 'drizzle-orm';
import { type Request, type Response } from 'express';

export const SESSION_COOKIE = 'sid';
export const SESSION_TTL = 7 * 24 * 60 * 60 * 1000;
export const ALLOWED_EMAIL_DOMAIN = 'onwrdadvisors.com';

/**
 * ONWRD workspace accounts must use an exact @onwrdadvisors.com address.
 * The comparison is case-insensitive and rejects subdomains or lookalike
 * addresses such as user@onwrdadvisors.com.evil.example.
 */
export function isAllowedEmail(email: unknown): email is string {
  if (typeof email !== 'string') return false;
  const normalized = email.trim().toLowerCase();
  const suffix = `@${ALLOWED_EMAIL_DOMAIN}`;
  if (!normalized.endsWith(suffix)) return false;
  const localPart = normalized.slice(0, -suffix.length);
  return localPart.length > 0 && !/[\s@]/.test(localPart);
}

export interface SessionData {
  user: AuthUser;
  provider?: 'google';
  access_token?: string;
  refresh_token?: string;
  expires_at?: number;
}

export async function createSession(data: SessionData): Promise<string> {
  const sid = crypto.randomBytes(32).toString('hex');
  await db.insert(sessionsTable).values({
    sid,
    sess: data as unknown as Record<string, unknown>,
    expire: new Date(Date.now() + SESSION_TTL),
  });
  return sid;
}

export async function getSession(sid: string): Promise<SessionData | null> {
  const [row] = await db
    .select()
    .from(sessionsTable)
    .where(eq(sessionsTable.sid, sid));

  if (!row || row.expire < new Date()) {
    if (row) await deleteSession(sid);
    return null;
  }

  return row.sess as unknown as SessionData;
}

export async function updateSession(
  sid: string,
  data: SessionData,
): Promise<void> {
  await db
    .update(sessionsTable)
    .set({
      sess: data as unknown as Record<string, unknown>,
      expire: new Date(Date.now() + SESSION_TTL),
    })
    .where(eq(sessionsTable.sid, sid));
}

export async function deleteSession(sid: string): Promise<void> {
  await db.delete(sessionsTable).where(eq(sessionsTable.sid, sid));
}

export async function clearSession(res: Response, sid?: string): Promise<void> {
  if (sid) await deleteSession(sid);
  res.clearCookie(SESSION_COOKIE, { path: '/' });
}

export function setSessionCookie(res: Response, sid: string): void {
  res.cookie(SESSION_COOKIE, sid, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_TTL,
  });
}

export function getSessionId(req: Request): string | undefined {
  const authHeader = req.headers['authorization'];
  if (authHeader?.startsWith('Bearer ')) {
    return authHeader.slice(7);
  }
  return req.cookies?.[SESSION_COOKIE];
}

export async function refreshGoogleSession(
  sid: string,
  session: SessionData,
): Promise<SessionData | null> {
  const now = Math.floor(Date.now() / 1000);
  if (!session.expires_at || now <= session.expires_at) return session;
  if (!session.refresh_token) return null;

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;

  let response: globalThis.Response;
  try {
    response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: session.refresh_token,
        client_id: clientId,
        client_secret: clientSecret,
      }).toString(),
    });
  } catch {
    return null;
  }

  if (!response.ok) return null;

  const tokens = (await response.json()) as {
    access_token?: string;
    expires_in?: number;
  };
  if (!tokens.access_token) return null;

  session.access_token = tokens.access_token;
  session.expires_at = tokens.expires_in
    ? now + tokens.expires_in
    : session.expires_at;
  await updateSession(sid, session);
  return session;
}

export async function upsertUser(claims: Record<string, unknown>) {
  const userData = {
    id: claims.sub as string,
    email: (claims.email as string) || null,
    firstName: (claims.given_name || claims.first_name) as string | null,
    lastName: (claims.family_name || claims.last_name) as string | null,
    profileImageUrl: (claims.picture || claims.profile_image_url) as
      | string
      | null,
  };

  const [user] = await db
    .insert(usersTable)
    .values(userData)
    .onConflictDoUpdate({
      target: usersTable.email,
      set: {
        firstName: userData.firstName,
        lastName: userData.lastName,
        profileImageUrl: userData.profileImageUrl,
        updatedAt: new Date(),
      },
    })
    .returning();
  return user;
}
