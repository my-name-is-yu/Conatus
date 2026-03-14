import * as fs from "node:fs";
import * as path from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

export interface LoggerConfig {
  dir: string;                    // Log directory path
  maxSizeMB?: number;            // Max size per log file (default: 10)
  maxFiles?: number;             // Max number of rotated files (default: 5)
  level?: LogLevel;              // Minimum log level (default: "info")
  consoleOutput?: boolean;       // Also log to console (default: true)
}

export class Logger {
  private dir: string;
  private maxSizeBytes: number;
  private maxFiles: number;
  private level: number;
  private consoleOutput: boolean;
  private currentFile: string;

  constructor(config: LoggerConfig) {
    this.dir = config.dir;
    this.maxSizeBytes = (config.maxSizeMB ?? 10) * 1024 * 1024;
    this.maxFiles = config.maxFiles ?? 5;
    this.level = LOG_LEVELS[config.level ?? "info"];
    this.consoleOutput = config.consoleOutput ?? true;
    this.currentFile = path.join(this.dir, "motiva.log");

    // Ensure log directory exists
    fs.mkdirSync(this.dir, { recursive: true });
  }

  debug(message: string, context?: Record<string, unknown>): void {
    this.log("debug", message, context);
  }

  info(message: string, context?: Record<string, unknown>): void {
    this.log("info", message, context);
  }

  warn(message: string, context?: Record<string, unknown>): void {
    this.log("warn", message, context);
  }

  error(message: string, context?: Record<string, unknown>): void {
    this.log("error", message, context);
  }

  private log(level: LogLevel, message: string, context?: Record<string, unknown>): void {
    if (LOG_LEVELS[level] < this.level) return;

    const timestamp = new Date().toISOString();
    const contextStr = context ? " " + JSON.stringify(context) : "";
    const line = `[${timestamp}] [${level.toUpperCase().padEnd(5)}] ${message}${contextStr}\n`;

    // Console output
    if (this.consoleOutput) {
      const consoleFn = level === "error" ? console.error
        : level === "warn" ? console.warn
        : console.log;
      consoleFn(line.trimEnd());
    }

    // File output
    this.writeToFile(line);
  }

  private writeToFile(line: string): void {
    try {
      // Check if rotation needed
      this.rotateIfNeeded();

      // Append to current log file
      fs.appendFileSync(this.currentFile, line, "utf-8");
    } catch {
      // Silently fail file writes (don't crash daemon for logging issues)
    }
  }

  private rotateIfNeeded(): void {
    try {
      if (!fs.existsSync(this.currentFile)) return;

      const stat = fs.statSync(this.currentFile);
      if (stat.size < this.maxSizeBytes) return;

      // Rotate: motiva.4.log -> delete, motiva.3.log -> motiva.4.log, etc.
      for (let i = this.maxFiles - 1; i >= 1; i--) {
        const older = path.join(this.dir, `motiva.${i + 1}.log`);
        const newer = path.join(this.dir, `motiva.${i}.log`);
        if (i === this.maxFiles - 1 && fs.existsSync(older)) {
          fs.unlinkSync(older);
        }
        if (fs.existsSync(newer)) {
          fs.renameSync(newer, older);
        }
      }

      // Current -> motiva.1.log
      fs.renameSync(this.currentFile, path.join(this.dir, "motiva.1.log"));
    } catch {
      // Ignore rotation errors
    }
  }
}
