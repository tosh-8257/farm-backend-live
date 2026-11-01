import { Module, forwardRef } from '@nestjs/common';
import { AuthModule } from '../auth.module';
import { NotificationsModule } from '../../notifications/notifications.module';
import { DiditModule } from '../../didit/didit.module';
import { DeviceBindingService } from './device-binding.service';
import {
  DeviceAdminController,
  DeviceBindingController,
  DeviceRecoveryAdminController,
} from './device-binding.controller';

@Module({
  // RolesGuard on the admin controllers needs JwtService (exported by AuthModule,
  // which imports this module, hence forwardRef).
  imports: [NotificationsModule, DiditModule, forwardRef(() => AuthModule)],
  controllers: [
    DeviceBindingController,
    DeviceAdminController,
    DeviceRecoveryAdminController,
  ],
  providers: [DeviceBindingService],
  exports: [DeviceBindingService],
})
export class DeviceBindingModule {}
