export interface BrowserAuthUser {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  readonly image?: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * Projects Better Auth's browser user into the application's actor model.
 *
 * The ids must remain identical: authorization always names `users.id`, while
 * Better Auth remains authoritative for browser authentication state.
 */
export interface BrowserAuthUserProjection {
  project(user: BrowserAuthUser): Promise<void>;
}
