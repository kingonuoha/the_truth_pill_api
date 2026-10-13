import { Module } from '@nestjs/common';
import { PrismaModule } from '../../core/prisma/prisma.module';
import { AdsController } from './ads.controller';

@Module({
  imports: [PrismaModule],
  controllers: [AdsController] })
export class AdsModule {}
