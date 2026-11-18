import { Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import { ConfigModule, ConfigService } from '@nestjs/config';

/**
 * GCP Cloud Logging severity levels mapping.
 * Maps Pino numeric levels to GCP severity strings.
 * https://cloud.google.com/logging/docs/reference/v2/rest/v2/LogEntry#LogSeverity
 */
const PINO_TO_GCP_SEVERITY: Record<number, string> = {
  10: 'DEBUG', // pino: trace
  20: 'DEBUG', // pino: debug
  30: 'INFO', // pino: info
  40: 'WARNING', // pino: warn
  50: 'ERROR', // pino: error
  60: 'CRITICAL', // pino: fatal
};

/**
 * StructuredLoggerModule - Configures Pino logger for GCP Cloud Logging.
 *
 * Features:
 * - JSON output format compatible with GCP Cloud Logging
 * - Maps log levels to GCP severity levels
 * - Pretty printing in development for readability
 * - Adds service name and environment context to all logs
 *
 * Usage:
 * Import StructuredLoggerModule.forRoot('service-name') in your app module.
 * Use the standard NestJS Logger in services - it will automatically use Pino.
 */
@Module({})
export class StructuredLoggerModule {
  /**
   * Configure the logger module for a specific service.
   * @param serviceName - Name of the service for log context
   */
  static forRoot(serviceName: string) {
    return LoggerModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        const nodeEnv = configService.get<string>('NODE_ENV', 'development');
        const isProduction = nodeEnv === 'production';

        return {
          pinoHttp: {
            // Base configuration
            level: configService.get<string>(
              'LOG_LEVEL',
              isProduction ? 'warn' : 'debug',
            ),

            // GCP-compatible JSON formatting
            formatters: {
              // Add GCP severity level to each log entry
              level: (label: string, number: number) => ({
                severity: PINO_TO_GCP_SEVERITY[number] || 'DEFAULT',
                level: label,
              }),

              // Format log entry with GCP-compatible fields
              log: (object: Record<string, unknown>) => {
                // GCP expects 'message' field for the log message
                const { msg, ...rest } = object;
                return {
                  ...rest,
                  message: msg,
                };
              },
            },

            // Add base fields to all log entries
            base: {
              serviceName,
              environment: nodeEnv,
            },

            // Customize timestamp format for GCP
            timestamp: () => `,"timestamp":"${new Date().toISOString()}"`,

            // Pretty print in development, JSON in production
            transport: isProduction
              ? undefined // Use default JSON transport in production
              : {
                  target: 'pino-pretty',
                  options: {
                    colorize: true,
                    translateTime: 'SYS:standard',
                    ignore: 'pid,hostname',
                    singleLine: false,
                  },
                },

            // Customize serializers for cleaner logs
            serializers: {
              // Reduce request log verbosity
              req: (req: {
                method: string;
                url: string;
                headers?: object;
              }) => ({
                method: req.method,
                // The query string can carry the whole request text of a GET.
                url: req.url.split('?')[0],
              }),
              // Reduce response log verbosity
              res: (res: { statusCode: number }) => ({
                statusCode: res.statusCode,
              }),
              // Properly serialize errors
              err: (err: Error) => ({
                type: err.constructor.name,
                message: err.message,
                stack: err.stack,
              }),
            },

            // Log HTTP requests in production (except health probes), quiet in dev
            autoLogging: isProduction
              ? {
                  ignore: (req: { url?: string }) =>
                    req.url === '/health' || req.url === '/health/ready',
                }
              : false,

            // Custom log method to add context
            customProps: () => ({
              context: 'HTTP',
            }),
          },
        };
      },
    });
  }
}
