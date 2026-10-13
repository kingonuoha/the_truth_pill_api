import { Module } from '@nestjs/common';
import { PrismaModule } from '../../core/prisma/prisma.module';
import { PillarsController } from './pillars.controller';
import { PillarsService } from './pillars.service';

@Module({
  imports: [PrismaModule],
  controllers: [PillarsController],
  providers: [PillarsService],
  exports: [PillarsService],
})
export class PillarsModule {}
