import { Module } from '@nestjs/common';
import { PrismaModule } from '../../core/prisma/prisma.module';
import { QuotesController } from './quotes.controller';

@Module({
  imports: [PrismaModule],
  controllers: [QuotesController] })
export class QuotesModule {}
