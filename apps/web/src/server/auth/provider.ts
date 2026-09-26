import "server-only";

// Identity provider adapter. Domain and service code only ever see a verified user id; the
// provider (Supabase Auth today) is an implementation detail behind this interface.

export interface AuthUser {
  id: string;
  email: string | null;
}

export interface AuthResult {
  error?: string;
  /** Sign-up succeeded but the provider requires email confirmation before sign-in. */
  needsConfirmation?: boolean;
}

export interface AuthProvider {
  /** The current user, verified with the identity provider (never trusted from an unverified cookie). */
  getUser(): Promise<AuthUser | null>;
  signInWithPassword(email: string, password: string): Promise<AuthResult>;
  signUp(email: string, password: string): Promise<AuthResult>;
  signOut(): Promise<void>;
}
