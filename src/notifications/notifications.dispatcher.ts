import { Injectable, Logger } from '@nestjs/common';
import { NotificationKind } from '@prisma/client';
import type { NotificationEvent } from './notifications.constants';

// A send is bounded so one unresponsive endpoint can't stall the sweeper.
const SEND_TIMEOUT_MS = 10_000;

export interface ChannelConfig {
  url: string;
}

/** Everything a message needs, already resolved from the DB. */
export interface NotificationContext {
  event: NotificationEvent;
  title: string;
  project: string | null;
  environment: string | null;
  commit: string | null;
  url: string | null;
  error: string | null;
  ok: boolean;
}

@Injectable()
export class NotificationDispatcher {
  private readonly logger = new Logger(NotificationDispatcher.name);

  async send(
    kind: NotificationKind,
    config: ChannelConfig,
    ctx: NotificationContext,
  ): Promise<void> {
    const body = this.render(kind, ctx);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
    try {
      const resp = await fetch(config.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!resp.ok) {
        // Body often carries the real reason (e.g. Slack's "invalid_token").
        const detail = (await resp.text().catch(() => '')).slice(0, 200);
        throw new Error(`${resp.status} ${resp.statusText} ${detail}`.trim());
      }
    } finally {
      clearTimeout(timer);
    }
  }

  private render(kind: NotificationKind, ctx: NotificationContext): unknown {
    switch (kind) {
      case NotificationKind.SLACK:
        return this.slack(ctx);
      case NotificationKind.DISCORD:
        return this.discord(ctx);
      case NotificationKind.WEBHOOK:
        return ctx;
    }
  }

  private slack(ctx: NotificationContext) {
    const fields = this.fields(ctx).map((f) => ({
      type: 'mrkdwn',
      text: `*${f.label}*\n${f.value}`,
    }));
    return {
      text: `${ctx.ok ? ':white_check_mark:' : ':x:'} ${ctx.title}`,
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `${ctx.ok ? ':white_check_mark:' : ':x:'} *${ctx.title}*`,
          },
        },
        ...(fields.length ? [{ type: 'section', fields }] : []),
      ],
    };
  }

  private discord(ctx: NotificationContext) {
    return {
      embeds: [
        {
          title: ctx.title,
          url: ctx.url ?? undefined,
          color: ctx.ok ? 0x2ea043 : 0xd1242f,
          fields: this.fields(ctx).map((f) => ({
            name: f.label,
            value: f.value,
            inline: true,
          })),
        },
      ],
    };
  }

  private fields(ctx: NotificationContext): { label: string; value: string }[] {
    const out: { label: string; value: string }[] = [];
    if (ctx.project) out.push({ label: 'Project', value: ctx.project });
    if (ctx.environment)
      out.push({ label: 'Environment', value: ctx.environment });
    if (ctx.commit) out.push({ label: 'Commit', value: ctx.commit });
    if (ctx.url) out.push({ label: 'URL', value: ctx.url });
    if (ctx.error) out.push({ label: 'Error', value: ctx.error.slice(0, 500) });
    return out;
  }
}
