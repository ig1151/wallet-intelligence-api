import pino from 'pino';
import { config } from './config';
export const logger = pino({
  level: config.logging.level,
  base: { service: 'wallet-intelligence-api' },
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: { paths: ['req.headers.authorization'], censor: '[REDACTED]' },
});