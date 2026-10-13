import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { validateEnv } from './env.validation';

/**
 * Global configuration. Loads `api/.env` (dotenv default, resolved from the
 * process working directory) and validates it once at boot (D1).
 *
 * `isGlobal: true` so `ConfigService` is injectable everywhere without every
 * module re-importing `ConfigModule`.
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      validate: validateEnv,
    }),
  ],
  exports: [ConfigModule],
})
export class AppConfigModule {}
