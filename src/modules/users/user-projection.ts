import type { AppRole } from '../../shared/guards/auth.decorators';

/**
 * The fields safe to return to the authenticated owner of a row. Explicitly
 * enumerated — never a spread of the DB row — so `password`, `resetToken`,
 * `resetTokenExpires`, `confirmationToken`, and `confirmationTokenExpires` can
 * never leak (DEV-034, §1.6.2 test 6).
 */
export interface SelfUserProjection {
  id: string;
  name: string;
  email: string;
  profileImage: string | null;
  provider: string;
  role: AppRole;
  newsletterSubscribed: boolean;
  emailConfirmed: boolean | null;
  completedTours: string[];
  createdAt: string;
}

/** Admin list projection. Same secret-free shape as the self projection. */
export type AdminUserProjection = SelfUserProjection;

/**
 * Public byline card for `/author/[id]` (group (a), §1.5 Item 3). Carries no
 * email, no role, and none of the secret/token columns.
 */
export interface PublicAuthorCard {
  id: string;
  name: string;
  profileImage: string | null;
}

/** The exact column set every projection reads. Selecting only these is the control. */
export const USER_PROJECTION_FIELDS = {
  id: true,
  name: true,
  email: true,
  profileImage: true,
  provider: true,
  role: true,
  newsletterSubscribed: true,
  emailConfirmed: true,
  completedTours: true,
  createdAt: true,
} as const;

/** The input shape a projection accepts — only the selected, safe columns. */
export interface ProjectionSource {
  id: string;
  name: string;
  email: string;
  profileImage: string | null;
  provider: string;
  role: AppRole;
  newsletterSubscribed: boolean;
  emailConfirmed: boolean | null;
  completedTours: string[];
  createdAt: Date;
}

export interface AuthorCardSource {
  id: string;
  name: string;
  profileImage: string | null;
}

/** Project a row for its owner or for an admin. No secrets. */
export function toSelfProjection(user: ProjectionSource): SelfUserProjection {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    profileImage: user.profileImage,
    provider: user.provider,
    role: user.role,
    newsletterSubscribed: user.newsletterSubscribed,
    emailConfirmed: user.emailConfirmed,
    completedTours: user.completedTours,
    createdAt: user.createdAt.toISOString(),
  };
}

/** Project a row as a public byline card. */
export function toPublicAuthorCard(user: AuthorCardSource): PublicAuthorCard {
  return {
    id: user.id,
    name: user.name,
    profileImage: user.profileImage,
  };
}
