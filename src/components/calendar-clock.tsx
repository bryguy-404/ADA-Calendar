"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

const CalendarClock = createContext<string | undefined>(undefined);

/** Seed hydration from the server, then refresh even when no work is edited. */
export function CalendarClockProvider({ initialNow, children }: { initialNow: string; children: ReactNode }) {
  const [now, setNow] = useState(initialNow);
  useEffect(() => {
    const refresh = () => setNow(new Date().toISOString());
    const timer = window.setInterval(refresh, 15_000);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    refresh();
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, []);
  return <CalendarClock.Provider value={now}>{children}</CalendarClock.Provider>;
}

export const useCalendarClock = () => useContext(CalendarClock);
