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

  /// Distinct from forbidden(): withholding a result for an outstanding
  /// balance is a parent-facing visibility rule, not an authorization
  /// failure — the caller IS permitted to read this student's results, the
  /// resource just isn't released yet. 402's literal meaning ("payment is
  /// required to access this") fits without overloading 403/404, both of
  /// which already carry other meanings in this API.
  static paymentRequired(message: string, details?: unknown): AppError {
    return new AppError(402, "PAYMENT_REQUIRED", message, details);
  }

  /// A genuinely unexpected server-side state, not a client mistake — e.g.
  /// login()'s loginId-then-email lookup matching more than one User, which
  /// can only mean a uniqueness invariant already broke. Named and thrown
  /// explicitly (rather than left to fall through to app.ts's generic
  /// unhandled-error 500) so it's greppable in logs as its own failure mode.
  static internal(message: string): AppError {
    return new AppError(500, "INTERNAL_ERROR", message);
  }

  /// Distinct from forbidden(): the account is fully authenticated and
  /// would otherwise be permitted, but is carrying a server-generated
  /// password it must replace first. A distinct code (not a generic 403) so
  /// the client can branch straight to "show the change-password screen"
  /// instead of treating this like an ordinary permission failure.
  static mustChangePassword(message = "This account must change its password before continuing"): AppError {
    return new AppError(403, "MUST_CHANGE_PASSWORD", message);
  }
}
