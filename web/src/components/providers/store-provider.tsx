'use client';

import { useEffect } from 'react';
import { useMoxenStore } from '../../lib/store';

/**
 * Initializes the Zustand store (SSE connection + initial data fetch) on mount.
 * Cleans up the SSE connection on unmount.
 */
export function StoreProvider({ children }: { children: React.ReactNode }) {
  const initialize = useMoxenStore((s) => s.initialize);
  const cleanup = useMoxenStore((s) => s.cleanup);

  useEffect(() => {
    initialize();
    return () => {
      cleanup();
    };
  }, [initialize, cleanup]);

  return <>{children}</>;
}
