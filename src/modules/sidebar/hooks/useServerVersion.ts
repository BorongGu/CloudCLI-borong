import { useEffect, useState } from 'react';

import { api } from '@/shared/api';
import { APP_VERSION } from '@/shared/constants';

/** The sidebar compares the local server with the installed client to show pending restarts. */
export function useServerVersion(): boolean {
  // A local version mismatch means the installed client and running server need a coordinated restart.
  const [restartRequired, setRestartRequired] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    const checkServerVersion = async () => {
      try {
        const response = await api.system.health({ signal: controller.signal });
        if (!response.ok || controller.signal.aborted) return;
        const data = await response.json();
        if (!controller.signal.aborted && typeof data.version === 'string' && data.version.length > 0) {
          setRestartRequired(data.version !== APP_VERSION);
        }
      } catch { /* Keep the current local restart state while the server is unreachable. */ }
    };
    void checkServerVersion();
    return () => controller.abort();
  }, []);

  return restartRequired;
}
