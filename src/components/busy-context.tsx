"use client";

import * as React from "react";

/**
 * Lets a screen tell the app shell "a run is in progress here", so switching screens from the
 * sidebar asks before throwing that work away. A screen calls `useReportBusy(running)`.
 */
const BusyContext = React.createContext<((key: string, busy: boolean) => void) | null>(null);

export function BusyProvider({ onChange, children }: { onChange: (busy: boolean) => void; children: React.ReactNode }) {
  const keys = React.useRef(new Set<string>());
  const report = React.useCallback(
    (key: string, busy: boolean) => {
      const had = keys.current.size > 0;
      if (busy) keys.current.add(key);
      else keys.current.delete(key);
      const has = keys.current.size > 0;
      if (had !== has) onChange(has);
    },
    [onChange],
  );
  return <BusyContext.Provider value={report}>{children}</BusyContext.Provider>;
}

/** Mark this screen busy while `busy` is true (cleared automatically on unmount). */
export function useReportBusy(busy: boolean): void {
  const report = React.useContext(BusyContext);
  const key = React.useId();
  React.useEffect(() => {
    report?.(key, busy);
    return () => report?.(key, false);
  }, [report, key, busy]);
}
