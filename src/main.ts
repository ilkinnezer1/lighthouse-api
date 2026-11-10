import type { Server } from 'node:http';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import cookieParser from 'cookie-parser';
import { ValidationPipe } from '@nestjs/common';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { rawBody: true });
  app.use(cookieParser());

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  // Node caps a whole request at 300 s, which a multi-GB dump import outlives,
  // and the cap cannot be scoped to one route. Headers stay bounded by
  // headersTimeout; the import route bounds a stalled body itself.
  (app.getHttpServer() as Server).requestTimeout = 0;
  await app.listen(process.env.PORT ?? 3000);
}
void bootstrap();
