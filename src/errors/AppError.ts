export class AppError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(statusCode: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = "AppError";
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }

  static badRequest(message: string, details?: unknown): AppError {
    return new AppError(400, "BAD_REQUEST", message, details);
  }

  static unauthorized(message = "Unauthorized"): AppError {
    return new AppError(401, "UNAUTHORIZED", message);
  }

  static forbidden(message = "Forbidden"): AppError {
    return new AppError(403, "FORBIDDEN", message);
  }

  /// Distinct from forbidden(): "you're authenticated but hold no role at
  /// all" is an account-provisioning problem, not "you tried something your
  /// role doesn't cover" — conflating the two behind FORBIDDEN would make a
  /// broken account look identical, over and over, to an ordinary
  /// per-action permission failure.
  static noRolesAssigned(message = "This account has no roles assigned"): AppError {
    return new AppError(403, "NO_ROLES_ASSIGNED", message);
  }

  static notFound(message = "Not Found"): AppError {
    return new AppError(404, "NOT_FOUND", message);
  }

  static conflict(message: string, details?: unknown): AppError {
    return new AppError(409, "CONFLICT", message, details);
  }
}
