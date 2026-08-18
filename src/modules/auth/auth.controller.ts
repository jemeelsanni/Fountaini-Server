import type { Request, Response } from "express";
import { AppError } from "../../errors/AppError.js";
import * as authService from "./auth.service.js";
import type { ChangePasswordBody, LoginBody, RefreshBody } from "./auth.schemas.js";

export async function login(req: Request, res: Response): Promise<void> {
  const { email, password } = req.body as LoginBody;
  const tokens = await authService.login({
    email,
    password,
    ip: req.ip,
    userAgent: req.get("user-agent"),
  });
  res.status(200).json({ accessToken: tokens.accessToken, refreshToken: tokens.refreshToken });
}

export async function refresh(req: Request, res: Response): Promise<void> {
  const { refreshToken } = req.body as RefreshBody;
  const tokens = await authService.refresh(refreshToken, req.ip, req.get("user-agent"));
  res.status(200).json({ accessToken: tokens.accessToken, refreshToken: tokens.refreshToken });
}

export async function logout(req: Request, res: Response): Promise<void> {
  const { refreshToken } = req.body as RefreshBody;
  await authService.logout(refreshToken);
  res.status(204).send();
}

export function me(req: Request, res: Response): void {
  if (!req.principal) {
    throw AppError.unauthorized();
  }
  res.status(200).json({ principal: req.principal });
}

export async function changePassword(req: Request, res: Response): Promise<void> {
  if (!req.principal) {
    throw AppError.unauthorized();
  }
  const { currentPassword, newPassword } = req.body as ChangePasswordBody;
  await authService.changePassword(req.principal.userId, currentPassword, newPassword);
  res.status(204).send();
}
