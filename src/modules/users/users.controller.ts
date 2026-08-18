import type { Request, Response } from "express";
import * as usersService from "./users.service.js";
import type { CreateUserBody, UserIdParams } from "./users.schemas.js";

export async function createUser(req: Request, res: Response): Promise<void> {
  const user = await usersService.createUser(req.body as CreateUserBody);
  res.status(201).json(user);
}

export async function listUsers(_req: Request, res: Response): Promise<void> {
  const users = await usersService.listUsers();
  res.status(200).json(users);
}

export async function getUser(req: Request, res: Response): Promise<void> {
  const { id } = req.params as unknown as UserIdParams;
  const user = await usersService.getUserById(id);
  res.status(200).json(user);
}

export async function activateUser(req: Request, res: Response): Promise<void> {
  const { id } = req.params as unknown as UserIdParams;
  const user = await usersService.setUserActive(id, true);
  res.status(200).json(user);
}

export async function deactivateUser(req: Request, res: Response): Promise<void> {
  const { id } = req.params as unknown as UserIdParams;
  const user = await usersService.setUserActive(id, false);
  res.status(200).json(user);
}
