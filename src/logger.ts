import winston from 'winston';

const { combine, timestamp, printf, colorize } = winston.format;

const botFormat = printf(({ level, message, timestamp, module, ...meta }) => {
  const mod = module ? `[${module}]` : '';
  const extra = Object.keys(meta).length > 0 ? ` ${JSON.stringify(meta)}` : '';
  return `${timestamp} ${level} ${mod} ${message}${extra}`;
});

export function createLogger(level: string = 'info'): winston.Logger {
  return winston.createLogger({
    level,
    format: combine(
      timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
      botFormat
    ),
    transports: [
      new winston.transports.Console({
        format: combine(colorize(), botFormat),
      }),
      new winston.transports.File({
        filename: './data/bot.log',
        maxsize: 10 * 1024 * 1024, // 10MB
        maxFiles: 5,
      }),
      new winston.transports.File({
        filename: './data/errors.log',
        level: 'error',
        maxsize: 10 * 1024 * 1024,
        maxFiles: 3,
      }),
    ],
  });
}

// Module-specific child loggers
export function moduleLogger(parent: winston.Logger, moduleName: string): winston.Logger {
  return parent.child({ module: moduleName });
}
