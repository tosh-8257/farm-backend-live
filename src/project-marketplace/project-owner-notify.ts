import { PrismaService } from '../database/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';

/**
 * Best-effort notice to the project owner. A failed notification never rolls
 * back the status change that triggered it.
 */
export async function notifyProjectOwner(
  prisma: PrismaService,
  notifications: NotificationsService | undefined,
  project: {
    id: string;
    project_name?: string | null;
    created_by?: string | null;
    business_id?: string | null;
  },
  title: string,
  body: string,
) {
  if (!notifications) return;
  let userId = project.created_by ?? null;
  if (!userId && project.business_id) {
    const business = await prisma.businesses.findUnique({
      where: { id: project.business_id },
      select: { owner_user_id: true },
    });
    userId = business?.owner_user_id ?? null;
  }
  if (!userId) return;
  const payload = { type: 'investment', project_id: project.id };
  await notifications
    .createInApp(userId, {
      type: 'investment',
      title,
      body,
      metadata: payload,
      entityId: project.id,
    })
    .catch(() => undefined);
  void notifications
    .sendPush(userId, title, body, payload)
    .catch(() => undefined);
}
