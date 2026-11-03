import { pino, type Logger as PinoLogger, type LoggerOptions } from 'pino';

/** The slice of pino the core modules use (tests pass a silent stub). */
export interface Logger {
  debug(obj: object, msg?: string): void;
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

export const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };

/** Query strings carry hub.verify_token and OAuth codes — never log them. */
export const stripQuery = (url: string | undefined): string | undefined => url?.split('?')[0];

export function loggerOptions(level: string): LoggerOptions {
  return {
    level,
    base: { app: 'ig-dm-bot' },
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'req.headers["x-hub-signature-256"]',
        'token',
        'accessToken',
        'access_token',
        '*.token',
        '*.accessToken',
        '*.access_token',
        '*.client_secret',
        '*.secret',
      ],
      censor: '[redacted]',
    },
    serializers: {
      req(req: { method?: string; url?: string; id?: string }) {
        return { method: req.method, url: stripQuery(req.url), id: req.id };
      },
    },
  };
}

export function createLogger(level: string): PinoLogger {
  return pino(loggerOptions(level));
}
