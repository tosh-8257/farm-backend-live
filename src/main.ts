import cluster from 'cluster';
import { cpus } from 'os';
import * as express from 'express';
import helmet from 'helmet';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ValidationPipe, Logger, VersioningType } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { validateSecurityEnvironment } from './config/environment-validation';
import { SafeInputValidationPipe } from './common/pipes/safe-input.pipe';
import { MERCHANT_CHECKOUT_URL } from './qr/merchant-checkout.constants';

async function bootstrap() {
  // SECURITY FIRST: Validate all security-critical environment variables
  // This runs BEFORE creating the app to fail fast if secrets are missing
  validateSecurityEnvironment();
  const app = await NestFactory.create(AppModule, { bodyParser: false });
  const expressApp = app.getHttpAdapter().getInstance() as express.Express;
  expressApp.get('/merchant-payment', (req, res) => {
    const queryIndex = req.originalUrl.indexOf('?');
    const query = queryIndex >= 0 ? req.originalUrl.slice(queryIndex) : '';
    return res.redirect(302, `${MERCHANT_CHECKOUT_URL}${query}`);
  });

  const rawBodySaver = (req: express.Request, res: express.Response, buf: Buffer, encoding: string) => {
    if (buf && buf.length) {
      const enc = (encoding as BufferEncoding) ?? 'utf8';
      (req as any).rawBody = buf.toString(enc);
    }
  };

  // Lightweight liveness probe for Render (no auth, no DB/Redis detail).
  expressApp.get('/health', (_req, res) => {
    res.status(200).json({ status: 'ok' });
  });

  // Large bodies are only accepted on routes that carry base64 uploads
  // (KYC documents and support-ticket attachments). Everything else is
  // capped at 1 MB. The first parser that runs marks the body as parsed,
  // so the global parsers below skip these routes.
  const LARGE_BODY_LIMIT = '29mb';
  const DEFAULT_BODY_LIMIT = '1mb';
  const largeBodyRoutes = [
    '/api/v1/kyc/submit',
    '/api/v1/support/tickets',
    '/api/v1/admin/support/tickets',
  ];
  app.use(largeBodyRoutes, express.json({ limit: LARGE_BODY_LIMIT, verify: rawBodySaver }));
  app.use(
    largeBodyRoutes,
    express.urlencoded({ extended: true, limit: LARGE_BODY_LIMIT, verify: rawBodySaver }),
  );
  app.use(express.json({ limit: DEFAULT_BODY_LIMIT, verify: rawBodySaver }));
  app.use(express.urlencoded({ extended: true, limit: DEFAULT_BODY_LIMIT, verify: rawBodySaver }));

  const isProduction = process.env.NODE_ENV === 'production';

  if (isProduction) {
    expressApp.set('trust proxy', true);
    app.use(
      helmet({
        hsts: {
          maxAge: 31536000,
          includeSubDomains: true,
          preload: true,
        },
      }),
    );
    app.use((req: express.Request, res: express.Response, next: express.NextFunction) => {
      const forwardedProto = (req.headers['x-forwarded-proto'] as string | undefined)?.split(',')[0]?.trim();
      if (req.secure || forwardedProto === 'https') {
        return next();
      }
      const host = req.headers.host;
      if (!host) {
        return next();
      }
      return res.redirect(301, `https://${host}${req.originalUrl}`);
    });
  } else {
    app.use(helmet());
  }

  app.setGlobalPrefix('api');
  app.enableVersioning({
    type: VersioningType.URI,
    defaultVersion: '1',
  });

  const configService = app.get(ConfigService);
  const configuredCorsOrigins = [
    configService.get<string>('CORS_ORIGINS'),
    configService.get<string>('FRONTEND_URL'),
    configService.get<string>('APP_URL'),
    'https://farmapp.africa',
    'https://www.farmapp.africa',
    'https://farmpay.africa',
    'https://www.farmpay.africa',
    'https://farmapp-e2145.web.app',
  ]
    .filter((value): value is string => Boolean(value))
    .flatMap((value) => value.split(',').map((origin) => origin.trim()).filter(Boolean));

  const corsOrigins = [...new Set(configuredCorsOrigins)];

  const localhostCorsRegex = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

  if (isProduction && corsOrigins?.includes('*')) {
    Logger.warn(
      'CORS_ORIGINS contains "*" in production. Wildcard origins are disabled for security.',
      'Bootstrap',
    );
  }

  const corsOriginMatches = (origin: string) => {
    return corsOrigins.some((allowedOrigin) => {
      if (allowedOrigin === '*') {
        return !isProduction;
      }

      if (allowedOrigin.startsWith('*.')) {
        return origin.endsWith(allowedOrigin.slice(1));
      }

      if (allowedOrigin.includes('*')) {
        const escaped = allowedOrigin.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
        const pattern = new RegExp(`^${escaped.replace(/\\\*/g, '.*')}$`);
        return pattern.test(origin);
      }

      return origin === allowedOrigin;
    });
  };

  const isAllowedCorsOrigin = (origin?: string) => {
    if (!origin) {
      return true;
    }

    // Localhost origins are only allowed outside production.
    return corsOriginMatches(origin) || (!isProduction && localhostCorsRegex.test(origin));
  };

  // Respond to browser preflight requests before the CORS package or any
  // authentication middleware can reject them without CORS headers.
  app.use((req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (req.method !== 'OPTIONS') {
      return next();
    }

    const origin = req.headers.origin;
    if (origin && !isAllowedCorsOrigin(origin)) {
      return res.sendStatus(403);
    }

    if (origin) {
      res.header('Access-Control-Allow-Origin', origin);
      res.header('Vary', 'Origin');
      res.header('Access-Control-Allow-Credentials', 'true');
    }
    res.header('Access-Control-Allow-Methods', 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS');
    res.header(
      'Access-Control-Allow-Headers',
      req.headers['access-control-request-headers'] ||
        'Content-Type, Authorization, Accept, Origin, X-Requested-With',
    );
    res.header('Access-Control-Max-Age', '86400');
    return res.sendStatus(204);
  });

  app.enableCors({
    origin: (origin, callback) => {
      return callback(null, isAllowedCorsOrigin(origin));
    },
    methods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Accept', 'Origin', 'X-Requested-With'],
    credentials: true,
  });

  app.useGlobalPipes(
    new SafeInputValidationPipe(),
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: {
        enableImplicitConversion: true,
      },
    }),
  );

  const port = Number(process.env.PORT || configService.get<number>('PORT') || 3000);

  // Validate required environment variables
  const requiredEnvVars = ['DATABASE_URL'];
  const missingEnvVars = requiredEnvVars.filter((envVar) => !process.env[envVar]);

  if (missingEnvVars.length > 0) {
    Logger.warn(
      `⚠️ Missing environment variables: ${missingEnvVars.join(', ')}`,
      'Bootstrap',
    );
    Logger.warn(
      'On Render.com: Connect a PostgreSQL database in the Render dashboard',
      'Bootstrap',
    );
  }

  try {
    await app.listen(port);
    Logger.log(
      `✅ Application is running on: ${await app.getUrl()}`,
      'Bootstrap',
    );
    Logger.log(
      `🔗 API: ${await app.getUrl()}/api/v1`,
      'Bootstrap',
    );
    Logger.log(
      `💚 Health check: ${await app.getUrl()}/api/v1/health`,
      'Bootstrap',
    );
  } catch (error) {
    if ((error as any)?.code === 'EADDRINUSE') {
      const fallbackPort = port + 1;
      Logger.warn(`Port ${port} is already in use. Trying ${fallbackPort} instead.`, 'Bootstrap');
      await app.listen(fallbackPort);
      Logger.log(
        `✅ Application is running on: ${await app.getUrl()}`,
        'Bootstrap',
      );
    } else {
      Logger.error(
        `❌ Failed to start application: ${error instanceof Error ? error.message : String(error)}`,
        (error as any)?.stack,
        'Bootstrap',
      );
      Logger.error(
        'Debug info: Check DATABASE_URL and other environment variables',
        'Bootstrap',
      );
      process.exit(1);
    }
  }
}

const clusteringEnabled = process.env.ENABLE_CLUSTER === 'true';

if (cluster.isPrimary && process.env.NODE_ENV === 'production' && clusteringEnabled) {
  const workerCount = Number(process.env.WEB_CONCURRENCY) || cpus().length;
  const logger = new Logger('Cluster');

  logger.log(`Master process started. Forking ${workerCount} workers.`);

  for (let i = 0; i < workerCount; i += 1) {
    cluster.fork();
  }

  cluster.on('exit', (worker, code, signal) => {
    const reason = signal
      ? `signal ${signal}`
      : `code ${code}${worker.exitedAfterDisconnect ? ' after disconnect' : ''}`;
    logger.error(`Worker ${worker.process.pid} exited with ${reason}. A replacement worker will be started.`);
    cluster.fork();
  });
} else {
  bootstrap().catch((error) => {
    const logger = new Logger('Bootstrap');
    logger.error(
      `Fatal application startup error: ${error instanceof Error ? error.message : String(error)}`,
      error instanceof Error ? error.stack : undefined,
    );
    process.exitCode = 1;
  });
}
