import { Module } from '@nestjs/common';
import { PrismaModule } from '../database/prisma.module';
import { CurrencyConversionService } from './currency-conversion.service';
import { LiveFxService } from './live-fx.service';

@Module({
  imports: [PrismaModule],
  providers: [CurrencyConversionService, LiveFxService],
  exports: [CurrencyConversionService, LiveFxService],
})
export class CurrencyModule {}
