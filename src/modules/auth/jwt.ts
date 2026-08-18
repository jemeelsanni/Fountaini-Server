import jwt from "jsonwebtoken";
import type { Role } from "../../../generated/prisma/index.js";
import { env } from "../../config/env.js";

export interface AccessTokenPayload {
  sub: string;
  roles: Role[];
  staffId: string | null;
  parentId: string | null;
  studentId: string | null;
}

export function signAccessToken(payload: AccessTokenPayload): string {
  return jwt.sign(payload, env.JWT_ACCESS_SECRET, {
    expiresIn: env.JWT_ACCESS_TTL_SECONDS,
  });
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  const decoded = jwt.verify(token, env.JWT_ACCESS_SECRET);
  if (typeof decoded === "string") {
    throw new Error("Unexpected access token payload shape");
  }
  return decoded as AccessTokenPayload & jwt.JwtPayload;
}
