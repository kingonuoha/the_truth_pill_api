import { Module } from '@nestjs/common';
import { PrismaModule } from '../../core/prisma/prisma.module';
import { SiteSettingsController } from './site-settings.controller';

@Module({
  imports: [PrismaModule],
  controllers: [SiteSettingsController] })
export class SiteSettingsModule {}
