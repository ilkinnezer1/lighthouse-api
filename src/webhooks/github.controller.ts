import {
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  Req,
} from '@nestjs/common';
import { GithubWebhookService } from './github.service';

@Controller('webhooks/github')
export class GithubWebhookController {
  constructor(private readonly service: GithubWebhookService) {}

  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  async receive(
    @Req() req: { rawBody?: Buffer },
    @Headers('x-hub-signature-256') signature: string | undefined,
    @Headers('x-github-event') event: string | undefined,
    @Headers('x-github-delivery') delivery: string | undefined,
  ) {
    return this.service.handle(req.rawBody ?? Buffer.alloc(0), {
      signature,
      event,
      delivery,
    });
  }
}
