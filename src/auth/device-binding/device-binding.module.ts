import { Module } from '@nestjs/common';
import { NotificationsModule } from '../../notifications/notifications.module';
import { DiditModule } from '../../didit/didit.module';
import { DeviceBindingService } from './device-binding.service';
import {
  DeviceAdminController,
  DeviceBindingController,
  DeviceRecoveryAdminController,
} from './device-binding.controller';

@Module({
  imports: [NotificationsModule, DiditModule],
  controllers: [
    DeviceBindingController,
    DeviceAdminController,
    DeviceRecoveryAdminController,
  ],
  providers: [DeviceBindingService],
  exports: [DeviceBindingService],
})
export class DeviceBindingModule {}
