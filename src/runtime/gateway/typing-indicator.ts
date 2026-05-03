import type {
  TypingIndicatorCapability,
  TypingIndicatorContext,
  TypingIndicatorSession,
  TypingIndicatorStatus,
} from "./channel-adapter.js";

export interface RefreshingTypingIndicatorOptions {
  status?: Extract<TypingIndicatorStatus, "native" | "fallback">;
  intervalMs: number;
  refresh: (context: TypingIndicatorContext) => Promise<void>;
  onError?: (err: unknown) => void;
}

export function createRefreshingTypingIndicator(
  options: RefreshingTypingIndicatorOptions
): TypingIndicatorCapability {
  return {
    status: options.status ?? "native",
    async start(context) {
      return startRefreshingTypingIndicator(context, options);
    },
  };
}

export function createUnsupportedTypingIndicator(reason: string): TypingIndicatorCapability {
  return {
    status: "unsupported",
    reason,
    async start() {
      return {
        status: "unsupported",
        async stop() {},
      };
    },
  };
}

async function startRefreshingTypingIndicator(
  context: TypingIndicatorContext,
  options: RefreshingTypingIndicatorOptions
): Promise<TypingIndicatorSession> {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const refreshOnce = async (): Promise<void> => {
    try {
      await options.refresh(context);
    } catch (err) {
      options.onError?.(err);
    }
  };

  const schedule = (): void => {
    if (stopped) return;
    timer = setTimeout(() => {
      timer = null;
      void refreshOnce().finally(schedule);
    }, options.intervalMs);
    timer.unref?.();
  };

  await refreshOnce();
  schedule();

  return {
    status: options.status ?? "native",
    async stop() {
      stopped = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}

export async function withTypingIndicator<T>(
  capability: TypingIndicatorCapability | undefined,
  context: TypingIndicatorContext,
  fn: () => Promise<T>
): Promise<T> {
  const session = await capability?.start(context).catch((err: unknown) => {
    console.warn("typing-indicator: start failed", err);
    return null;
  });
  try {
    return await fn();
  } finally {
    await session?.stop().catch((err: unknown) => {
      console.warn("typing-indicator: stop failed", err);
    });
  }
}
