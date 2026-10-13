import {
  registerDecorator,
  ValidationArguments,
  ValidationOptions,
} from 'class-validator';

const BCRYPT_HASH_PATTERN = /^\$2[aby]\$\d{2}\$/;

/** Minimum accepted plaintext password length. */
export const MIN_PASSWORD_LENGTH = 8;

/** bcrypt's input limit, in bytes. */
export const MAX_PASSWORD_BYTES = 72;

/**
 * Accepts a plaintext password only (DEV-033).
 *
 * A value that already looks like a bcrypt modular-crypt hash is rejected, so a
 * caller cannot supply a pre-hashed credential. Length is bounded on both ends
 * so a 60-char hash cannot masquerade as a password and an over-long value
 * cannot be silently truncated by bcrypt.
 */
export function IsPlaintextPassword(options?: ValidationOptions): PropertyDecorator {
  return (object: object, propertyName: string | symbol): void => {
    registerDecorator({
      name: 'isPlaintextPassword',
      target: object.constructor,
      propertyName: String(propertyName),
      options,
      validator: {
        validate(value: unknown): boolean {
          if (typeof value !== 'string') return false;
          if (value.length < MIN_PASSWORD_LENGTH) return false;
          if (value.length > MAX_PASSWORD_BYTES) return false;
          return !BCRYPT_HASH_PATTERN.test(value);
        },
        defaultMessage(args: ValidationArguments): string {
          return `${args.property} must be a plaintext password (${MIN_PASSWORD_LENGTH}-${MAX_PASSWORD_BYTES} chars, not a pre-hashed value)`;
        },
      },
    });
  };
}
