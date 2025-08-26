// Import this first from sentry instrument!
import '@utils/instrumentSentry';

// Agora os outros módulos
import { ProviderFiles } from '@api/provider/sessions';
import { PrismaRepository } from '@api/repository/repository.service';
import { HttpStatus, router } from '@api/routes/index.router';
import { eventManager, waMonitor } from '@api/server.module';
import { Auth, configService, Cors, HttpServer, ProviderSession, Webhook } from '@config/env.config';
import { onUnexpectedError } from '@config/error.config';
import { Logger } from '@config/logger.config';
import { ROOT_DIR } from '@config/path.config';
import * as Sentry from '@sentry/node';
import { ServerUP } from '@utils/server-up';
import axios from 'axios';
import compression from 'compression';
import cors from 'cors';
import express, { json, NextFunction, Request, Response, urlencoded } from 'express';
import { join } from 'path';

function initWA() {
  waMonitor.loadInstance();
}

async function bootstrap() {
  const logger = new Logger('SERVER');
  const app = express();

  // Middlewares base
  app.use(
    cors({
      origin(requestOrigin, callback) {
        const { ORIGIN } = configService.get<Cors>('CORS');
        if (ORIGIN.includes('*')) return callback(null, true);
        if (requestOrigin && ORIGIN.indexOf(requestOrigin) !== -1) return callback(null, true);
        return callback(new Error('Not allowed by CORS'));
      },
      methods: [...configService.get<Cors>('CORS').METHODS],
      credentials: configService.get<Cors>('CORS').CREDENTIALS,
    }),
    urlencoded({ extended: true, limit: '136mb' }),
    json({ limit: '136mb' }),
    compression(),
  );

  app.set('view engine', 'hbs');
  app.set('views', join(ROOT_DIR, 'views'));
  app.use(express.static(join(ROOT_DIR, 'public')));
  app.use('/store', express.static(join(ROOT_DIR, 'store')));

  // Rotas principais
  app.use('/', router);

  // Healthcheck exigido pelo Render
  app.get('/healthz', (_req, res) => res.status(200).send('ok'));

  // Sentry error handler — depois das rotas, antes dos seus error middlewares
  if (process.env.SENTRY_DSN) {
    logger.info('Sentry - ON');
    Sentry.setupExpressErrorHandler(app);
  }

  // Middleware de erro
  app.use(async (err: Error, _req: Request, res: Response, next: NextFunction) => {
    if (!err) return next();

    const webhook = configService.get<Webhook>('WEBHOOK');
    try {
      if (webhook.EVENTS.ERRORS_WEBHOOK && webhook.EVENTS.ERRORS_WEBHOOK !== '' && webhook.EVENTS) {
        const tzoffset = new Date().getTimezoneOffset() * 60000;
        const localISOTime = new Date(Date.now() - tzoffset).toISOString();
        const now = localISOTime;
        const globalApiKey = configService.get<Auth>('AUTHENTICATION').API_KEY.KEY;
        const serverUrl = configService.get<HttpServer>('SERVER').URL;

        const errorData = {
          event: 'error',
          data: {
            error: (err as any).error || 'Internal Server Error',
            message: err.message || 'Internal Server Error',
            status: (err as any).status || 500,
            response: { message: err.message || 'Internal Server Error' },
          },
          date_time: now,
          api_key: globalApiKey,
          server_url: serverUrl,
        };

        logger.error(errorData);
        await axios.create({ baseURL: webhook.EVENTS.ERRORS_WEBHOOK }).post('', errorData);
      }
    } catch {
      // não deixa o webhook derrubar a resposta
    }

    return res.status((err as any).status || 500).json({
      status: (err as any).status || 500,
      error: (err as any).error || 'Internal Server Error',
      response: { message: err.message || 'Internal Server Error' },
    });
  });

  // 404 handler
  app.use((req: Request, res: Response, next: NextFunction) => {
    const { method, url } = req;
    res.status(HttpStatus.NOT_FOUND).json({
      status: HttpStatus.NOT_FOUND,
      error: 'Not Found',
      response: { message: [`Cannot ${method.toUpperCase()} ${url}`] },
    });
    next();
  });

  // Provider de arquivos (opcional)
  let providerFiles: ProviderFiles | null = null;
  if (configService.get<ProviderSession>('PROVIDER').ENABLED) {
    providerFiles = new ProviderFiles(configService);
    await providerFiles.onModuleInit();
    logger.info('Provider:Files - ON');
  }

  // Prisma
  const prismaRepository = new PrismaRepository(configService);
  await prismaRepository.onModuleInit();

  // Server (HTTP/HTTPS) via helper
  const httpServer = configService.get<HttpServer>('SERVER');
  ServerUP.app = app;
  let server = ServerUP[httpServer.TYPE];

  // Se SSL falhar, cai para HTTP
  if (server === null) {
    logger.warn('SSL cert load failed — falling back to HTTP.');
    logger.info("Ensure 'SSL_CONF_PRIVKEY' and 'SSL_CONF_FULLCHAIN' env vars point to valid certificate files.");
    httpServer.TYPE = 'http';
    server = ServerUP[httpServer.TYPE];
  }

  // Porta do Render (se houver)
  const PORT = Number(process.env.PORT ?? httpServer.PORT ?? 8080);
  httpServer.PORT = PORT;

  // Inicializa gerenciador de eventos (se existir)
  try {
    eventManager?.init?.(server);
  } catch (e) {
    logger.warn('eventManager init skipped: ' + (e as any)?.message);
  }

  // ⚠️ Importante: apenas 1 argumento no listen (evita TS2554)
  server.listen(httpServer.PORT);

  // Log separado
  logger.log(`${httpServer.TYPE.toUpperCase()} - ON: ${httpServer.PORT}`);

  // Encerramento gracioso
  process.on('SIGTERM', () => {
    logger.warn('SIGTERM received — shutting down gracefully');
    try {
      server.close?.(() => {
        logger.info('HTTP server closed');
        process.exit(0);
      });
      setTimeout(() => process.exit(0), 10_000).unref();
    } catch (e) {
      logger.error('Error on graceful shutdown', e as any);
      process.exit(1);
    }
  });

  initWA();
  onUnexpectedError();
}

bootstrap();
