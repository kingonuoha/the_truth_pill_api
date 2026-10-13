import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { PrismaService } from '../../core/prisma/prisma.service';
import { FixedWindowThrottle } from '../../shared/throttle';
import { JtiDenylistService } from '../auth/jti-denylist.service';
import { PasswordService } from '../auth/password.service';
import { ScopedTokenService } from '../auth/scoped-token.service';
import {
  CompleteTourDto,
  ConfirmNewsletterDto,
  MintResetTokenDto,
  RegisterDto,
  ResetPasswordDto,
  StoreUserDto,
  SubscribeNewsletterDto,
  UnsubscribeDto,
  UpdateProfileDto,
} from './dto/users.dto';
import {
  AdminUserProjection,
  PublicAuthorCard,
  SelfUserProjection,
  toPublicAuthorCard,
  toSelfProjection,
  USER_PROJECTION_FIELDS,
} from './user-projection';

/** Confirmation links are valid for 24 h. */
export const NEWSLETTER_CONFIRM_TTL_SECONDS = 24 * 60 * 60;
/** Unsubscribe links are valid for 30 days. */
export const UNSUBSCRIBE_TTL_SECONDS = 30 * 24 * 60 * 60;
/** Reset links are short-lived. */
export const RESET_TOKEN_TTL_SECONDS = 60 * 60;

export interface NewsletterStats {
  bookmarks: number;
  comments: number;
  reactions: number;
}

export interface SelfFull extends SelfUserProjection {
  stats: NewsletterStats;
}

export interface IssuedNewsletterToken {
  status: 'verification_sent' | 'subscribed';
  /** Present only for internal callers (the email worker). Never serialised. */
  token?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isUniqueViolation(error: unknown): boolean {
  return isRecord(error) && error.code === 'P2002';
}

/**
 * The 16 `web/convex/users.ts` behaviours, identity-free (DEV-029…DEV-037).
 *
 * Every method takes the acting subject as an explicit `sub` argument resolved
 * by the guard — never from a request body. No method accepts a caller-supplied
 * identity selector such as an admin or user email, or an account id.
 */
@Injectable()
export class UsersService {
  /** Bounds confirmation-token guessing and replay (P02-SEC-001). */
  private readonly confirmThrottle = new FixedWindowThrottle(10, 60_000);

  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly scopedTokens: ScopedTokenService,
    private readonly denylist: JtiDenylistService,
  ) {}

  /* ------------------------------------------------------------------ *
   * Registration & internal upsert
   * ------------------------------------------------------------------ */

  /**
   * Public registration. Always returns the same neutral status, whether or not
   * the address already exists — no enumeration oracle (DEV-037).
   */
  async register(dto: RegisterDto): Promise<{ status: 'ok' }> {
    const existing = await this.prisma.user.findUnique({
      where: { email: dto.email },
      select: { id: true },
    });
    if (existing) return { status: 'ok' };

    const password = await this.passwords.hash(dto.password);
    try {
      await this.prisma.user.create({
        data: {
          name: dto.name,
          email: dto.email,
          password,
          provider: 'email',
          role: 'user',
          newsletterSubscribed: dto.newsletterSubscribed ?? false,
          createdAt: new Date(),
        },
      });
    } catch (error) {
      // A concurrent registration may win the unique index; stay neutral.
      if (!isUniqueViolation(error)) throw error;
    }
    return { status: 'ok' };
  }

  /**
   * Internal Google sign-in upsert. `provider` is forced to `google` server-side;
   * it is never a client input (DEV-037). Returns the Postgres id.
   */
  async storeUser(dto: StoreUserDto): Promise<{ id: string }> {
    const existing = await this.prisma.user.findUnique({
      where: { email: dto.email },
      select: { id: true, profileImage: true },
    });

    if (existing) {
      if (dto.profileImage && existing.profileImage !== dto.profileImage) {
        await this.prisma.user.update({
          where: { id: existing.id },
          data: { profileImage: dto.profileImage },
        });
      }
      return { id: existing.id };
    }

    const created = await this.prisma.user.create({
      data: {
        name: dto.name,
        email: dto.email,
        profileImage: dto.profileImage ?? null,
        provider: 'google',
        role: 'user',
        newsletterSubscribed: false,
        createdAt: new Date(),
      },
      select: { id: true },
    });
    return { id: created.id };
  }

  /* ------------------------------------------------------------------ *
   * Self projections
   * ------------------------------------------------------------------ */

  async getSelf(sub: string): Promise<SelfUserProjection> {
    const user = await this.prisma.user.findUnique({
      where: { id: sub },
      select: USER_PROJECTION_FIELDS,
    });
    if (!user) throw new UnauthorizedException('Unknown subject');
    return toSelfProjection(user);
  }

  async getSelfFull(sub: string): Promise<SelfFull> {
    const user = await this.prisma.user.findUnique({
      where: { id: sub },
      select: USER_PROJECTION_FIELDS,
    });
    if (!user) throw new UnauthorizedException('Unknown subject');

    const [bookmarks, comments, reactions] = await Promise.all([
      this.prisma.bookmark.count({ where: { user: { id: sub } } }),
      this.prisma.comment.count({ where: { user: { id: sub } } }),
      this.prisma.reaction.count({ where: { user: { id: sub } } }),
    ]);

    return {
      ...toSelfProjection(user),
      stats: { bookmarks, comments, reactions },
    };
  }

  async updateProfile(
    sub: string,
    dto: UpdateProfileDto,
  ): Promise<SelfUserProjection> {
    const user = await this.prisma.user.update({
      where: { id: sub },
      data: {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.profileImage !== undefined
          ? { profileImage: dto.profileImage }
          : {}),
        ...(dto.newsletterSubscribed !== undefined
          ? { newsletterSubscribed: dto.newsletterSubscribed }
          : {}),
      },
      select: USER_PROJECTION_FIELDS,
    });
    return toSelfProjection(user);
  }

  async completeTour(
    sub: string,
    dto: CompleteTourDto,
  ): Promise<{ success: true }> {
    const user = await this.prisma.user.findUnique({
      where: { id: sub },
      select: { completedTours: true },
    });
    if (!user) throw new UnauthorizedException('Unknown subject');

    if (!user.completedTours.includes(dto.tourId)) {
      await this.prisma.user.update({
        where: { id: sub },
        data: { completedTours: [...user.completedTours, dto.tourId] },
      });
    }
    return { success: true };
  }

  async deleteAccount(sub: string): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.bookmark.deleteMany({ where: { user: { id: sub } } }),
      this.prisma.comment.deleteMany({ where: { user: { id: sub } } }),
      this.prisma.reaction.deleteMany({ where: { user: { id: sub } } }),
      this.prisma.user.delete({ where: { id: sub } }),
    ]);
  }

  /* ------------------------------------------------------------------ *
   * Public author card
   * ------------------------------------------------------------------ */

  async getUserById(id: string): Promise<PublicAuthorCard> {
    let user: { id: string; name: string; profileImage: string | null } | null;
    try {
      user = await this.prisma.user.findUnique({
        where: { id },
        select: { id: true, name: true, profileImage: true },
      });
    } catch {
      throw new NotFoundException('User not found');
    }
    if (!user) throw new NotFoundException('User not found');
    return toPublicAuthorCard(user);
  }

  /* ------------------------------------------------------------------ *
   * Newsletter
   * ------------------------------------------------------------------ */

  /**
   * Double opt-in request. Mints a CSPRNG, expiring, purpose-scoped token and
   * stores only its SHA-256 hash (DEV-036, DEV-037). The response is neutral for
   * every address (existing, new, or already-subscribed).
   */
  async subscribeToNewsletter(
    dto: SubscribeNewsletterDto,
  ): Promise<IssuedNewsletterToken> {
    const user = await this.prisma.user.findUnique({
      where: { email: dto.email },
      select: { id: true, emailConfirmed: true },
    });

    let subjectId: string;
    if (user) {
      subjectId = user.id;
      if (user.emailConfirmed === true) {
        await this.prisma.user.update({
          where: { id: user.id },
          data: { newsletterSubscribed: true },
        });
        return { status: 'subscribed' };
      }
    } else {
      const created = await this.prisma.user.create({
        data: {
          name: 'Guest',
          email: dto.email,
          provider: 'guest',
          role: 'user',
          newsletterSubscribed: false,
          emailConfirmed: false,
          createdAt: new Date(),
        },
        select: { id: true },
      });
      subjectId = created.id;
    }

    const minted = this.scopedTokens.mint(
      'newsletter-confirm',
      subjectId,
      NEWSLETTER_CONFIRM_TTL_SECONDS,
    );
    await this.prisma.user.update({
      where: { id: subjectId },
      data: { confirmationToken: minted.tokenHash },
    });

    return { status: 'verification_sent', token: minted.token };
  }

  /**
   * Confirm a newsletter subscription (P02-SEC-001). The token must be validly
   * signed for this purpose, unexpired, single-use, throttled, and match the
   * hash stored at rest; an already-confirmed user is refused. The two legacy
   * plaintext imported tokens never match a hash and are therefore invalid.
   */
  async confirmNewsletter(
    dto: ConfirmNewsletterDto,
    clientKey: string,
  ): Promise<{ success: boolean }> {
    const decision = this.confirmThrottle.consume(clientKey);
    if (!decision.allowed) {
      // Neutral body; do not reveal the throttle as an oracle.
      return { success: false };
    }

    const payload = this.scopedTokens.verify(
      'newsletter-confirm',
      dto.token,
    );
    if (this.denylist.isRevoked(payload.jti)) {
      return { success: false };
    }

    const tokenHash = this.scopedTokens.hash(dto.token);
    const user = await this.prisma.user.findFirst({
      where: { id: payload.sub, confirmationToken: tokenHash },
      select: { id: true, emailConfirmed: true },
    });
    if (!user) return { success: false };
    if (user.emailConfirmed === true) {
      // Refuse a token presented for an already-confirmed user.
      return { success: false };
    }

    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        newsletterSubscribed: true,
        emailConfirmed: true,
        confirmationToken: null,
      },
    });
    this.denylist.revoke(payload.jti, payload.exp * 1000);
    return { success: true };
  }

  /**
   * Unsubscribe via a signed, single-use token (DEV-035). There is no
   * bare-`email` variant; the mutated row is the token's own subject only.
   */
  async unsubscribe(dto: UnsubscribeDto): Promise<{ success: true }> {
    const payload = this.scopedTokens.verify(
      'newsletter-unsubscribe',
      dto.token,
    );
    if (this.denylist.isRevoked(payload.jti)) {
      throw new UnauthorizedException('Token already used');
    }

    await this.prisma.user.updateMany({
      where: { id: payload.sub },
      data: { newsletterSubscribed: false },
    });
    this.denylist.revoke(payload.jti, payload.exp * 1000);
    return { success: true };
  }

  /* ------------------------------------------------------------------ *
   * Password reset (internal mint + public consume)
   * ------------------------------------------------------------------ */

  /**
   * Internal reset-token mint (DEV-036). The token is CSPRNG; only its hash and
   * expiry are stored (`resetToken`, `resetTokenExpires`). Returns `null` for an
   * unknown address so the caller does not reveal existence.
   */
  async mintResetToken(
    dto: MintResetTokenDto,
  ): Promise<{ token: string; expiresAt: string } | null> {
    const user = await this.prisma.user.findUnique({
      where: { email: dto.email },
      select: { id: true },
    });
    if (!user) return null;

    const minted = this.scopedTokens.mint(
      'password-reset',
      user.id,
      RESET_TOKEN_TTL_SECONDS,
    );
    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        resetToken: minted.tokenHash,
        resetTokenExpires: minted.expiresAt,
      },
    });
    return { token: minted.token, expiresAt: minted.expiresAt.toISOString() };
  }

  /**
   * Consume a reset token (DEV-033, DEV-036, §1.6.2 test 5). An absent, stolen,
   * unknown, expired, or already-consumed token is **401** — never accepted.
   * The new password is hashed server-side; a pre-hashed value is rejected by
   * the DTO before it reaches here.
   */
  async resetPassword(dto: ResetPasswordDto): Promise<{ success: true }> {
    let payload;
    try {
      payload = this.scopedTokens.verify('password-reset', dto.token);
    } catch {
      throw new UnauthorizedException('Invalid or expired reset token');
    }

    const tokenHash = this.scopedTokens.hash(dto.token);
    const user = await this.prisma.user.findFirst({
      where: { id: payload.sub, resetToken: tokenHash },
      select: { id: true, resetTokenExpires: true },
    });
    if (
      !user ||
      !user.resetTokenExpires ||
      user.resetTokenExpires.getTime() < Date.now()
    ) {
      throw new UnauthorizedException('Invalid or expired reset token');
    }

    const password = await this.passwords.hash(dto.password);
    await this.prisma.user.update({
      where: { id: user.id },
      data: { password, resetToken: null, resetTokenExpires: null },
    });
    this.denylist.revoke(payload.jti, payload.exp * 1000);
    return { success: true };
  }

  /* ------------------------------------------------------------------ *
   * Admin
   * ------------------------------------------------------------------ */

  async listAllUsers(
    page: number,
    pageSize: number,
  ): Promise<{ items: AdminUserProjection[]; total: number }> {
    const [rows, total] = await Promise.all([
      this.prisma.user.findMany({
        select: USER_PROJECTION_FIELDS,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.user.count(),
    ]);
    return { items: rows.map(toSelfProjection), total };
  }

  /**
   * Change a user's role (DEV-001). The actor is the verified admin `sub`; no
   * caller-supplied identity exists. Refuses to demote the last remaining admin, which
   * would lock the deployment out of its own admin surface.
   */
  async updateUserRole(
    targetId: string,
    role: 'admin' | 'user',
  ): Promise<AdminUserProjection> {
    let target: { id: string; role: string } | null;
    try {
      target = await this.prisma.user.findUnique({
        where: { id: targetId },
        select: { id: true, role: true },
      });
    } catch {
      throw new NotFoundException('User not found');
    }
    if (!target) throw new NotFoundException('User not found');

    if (target.role === 'admin' && role === 'user') {
      const admins = await this.prisma.user.count({ where: { role: 'admin' } });
      if (admins <= 1) {
        throw new ConflictException('Cannot demote the last administrator');
      }
    }

    const updated = await this.prisma.user.update({
      where: { id: target.id },
      data: { role },
      select: USER_PROJECTION_FIELDS,
    });
    return toSelfProjection(updated);
  }
}
