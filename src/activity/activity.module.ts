import { Module } from '@nestjs/common';
import { ActivityController } from '@/activity/activity.controller';
import { ActivityService } from '@/activity/activity.service';

@Module({
  controllers: [ActivityController],
  providers: [ActivityService],
})
export class ActivityModule {}
