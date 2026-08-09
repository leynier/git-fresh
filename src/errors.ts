export type GitFreshErrorCode =
  | "NOT_A_REPOSITORY"
  | "NOT_REPOSITORY_ROOT"
  | "UNSAFE_REPOSITORY_STATE"
  | "DIRTY_NESTED_REPOSITORY"
  | "INVALID_GLOB_PATTERN"
  | "NON_INTERACTIVE_CONFIRMATION_REQUIRED"
  | "GIT_COMMAND_FAILED"
  | "STASH_NOT_CREATED"
  | "STASH_APPLY_FAILED"
  | "STATE_VERIFICATION_FAILED";

export class GitFreshError extends Error {
  constructor(
    public readonly code: GitFreshErrorCode,
    message: string,
    public readonly details?: string,
  ) {
    super(message);
    this.name = "GitFreshError";
  }
}
