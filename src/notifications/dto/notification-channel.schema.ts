import { z } from 'zod';
import { ALL_NOTIFICATION_EVENTS } from '../notifications.constants';

// Only https, and no obviously-internal target. The URL is user-supplied and
// the API fetches it server-side, so this is an SSRF surface — a self-hosted
// box typically sits next to metadata endpoints and private services.
const webhookUrlSchema = z
  .string()
  .url()
  .max(2048)
  .refine((u) => u.startsWith('https://'), 'webhook URL must use https')
  .refine((u) => {
    const host = new URL(u).hostname.toLowerCase();
    if (host === 'localhost' || host.endsWith('.localhost')) return false;
    if (/^(127|10)\./.test(host)) return false;
    if (/^192\.168\./.test(host)) return false;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return false;
    if (host === '169.254.169.254' || host.startsWith('169.254.')) return false;
    if (host === '::1' || host === '[::1]') return false;
    return true;
  }, 'webhook URL must not point at a private or link-local address');

export const CreateNotificationChannelSchema = z
  .object({
    name: z.string().min(1).max(100),
    kind: z.enum(['SLACK', 'DISCORD', 'WEBHOOK']),
    url: webhookUrlSchema,
    enabled: z.boolean().optional(),
    // Empty means every event the notifier knows about.
    events: z.array(z.enum(ALL_NOTIFICATION_EVENTS)).optional(),
  })
  .strict();

export type CreateNotificationChannelInput = z.infer<
  typeof CreateNotificationChannelSchema
>;

export const UpdateNotificationChannelSchema = z
  .object({
    name: z.string().min(1).max(100).optional(),
    url: webhookUrlSchema.optional(),
    enabled: z.boolean().optional(),
    events: z.array(z.enum(ALL_NOTIFICATION_EVENTS)).optional(),
  })
  .strict();

export type UpdateNotificationChannelInput = z.infer<
  typeof UpdateNotificationChannelSchema
>;
