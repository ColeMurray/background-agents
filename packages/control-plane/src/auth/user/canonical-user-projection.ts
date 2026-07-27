export interface UserProjectionInput {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  readonly image?: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * Projects Better Auth's user into the application's actor model.
 *
 * The ids must remain identical: authorization always names `users.id`, while
 * Better Auth remains authoritative for authentication state.
 */
export interface CanonicalUserProjection {
  project(user: UserProjectionInput): Promise<void>;
}
