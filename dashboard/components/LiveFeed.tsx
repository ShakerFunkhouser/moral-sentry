"use client";

import { useEffect, useRef, useState } from "react";

interface LiveEvent {
  id: string;
  toolName: string;
  agentIntent?: string;
  decision: "allow" | "block" | "escalate";
  divergence: number;
  prescribed: string;
  timestamp: number;
}

const MAX_EVENTS = 20;

const DECISION_STYLES: Record<
  LiveEvent["decision"],
  { badge: string; dot: string }
> = {
  allow: {
    badge: "bg-emerald-900/60 text-emerald-300 border border-emerald-700/50",
    dot: "bg-emerald-400",
  },
  block: {
    badge: "bg-red-900/60 text-red-300 border border-red-700/50",
    dot: "bg-red-400",
  },
  escalate: {
    badge: "bg-amber-900/60 text-amber-300 border border-amber-700/50",
    dot: "bg-amber-400",
  },
};

function timeAgo(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  return `${Math.floor(s / 60)}m ago`;
}

export function LiveFeed() {
  const [events, setEvents] = useState<LiveEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const esRef = useRef<EventSource | null>(null);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Force re-render every 5 s so the "time ago" labels stay fresh
  const [, setTick] = useState(0);

  useEffect(() => {
    tickRef.current = setInterval(() => setTick((t) => t + 1), 5000);
    return () => {
      if (tickRef.current) clearInterval(tickRef.current);
    };
  }, []);

  useEffect(() => {
    const es = new EventSource("/api/events");
    esRef.current = es;

    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);

    es.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data) as Omit<LiveEvent, "id">;
        setEvents((prev) => {
          const next: LiveEvent = {
            ...data,
            id: `${data.timestamp}-${Math.random().toString(36).slice(2, 7)}`,
          };
          return [next, ...prev].slice(0, MAX_EVENTS);
        });
      } catch {
        // ignore parse errors
      }
    };

    return () => {
      es.close();
      setConnected(false);
    };
  }, []);

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-5">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-sm font-semibold text-zinc-300 tracking-wide uppercase">
          Live Hook Feed
        </h2>
        <div className="flex items-center gap-1.5">
          <span
            className={`h-2 w-2 rounded-full ${
              connected ? "bg-emerald-400 animate-pulse" : "bg-zinc-600"
            }`}
          />
          <span className="text-xs text-zinc-500">
            {connected ? "Connected" : "Waiting…"}
          </span>
        </div>
      </div>

      {events.length === 0 ? (
        <p className="text-xs text-zinc-600 italic">
          No hook calls received yet. Run the gateway with{" "}
          <code className="font-mono text-zinc-500">
            MORAL_SENTRY_DASHBOARD_URL=http://localhost:3000
          </code>{" "}
          to stream decisions here in real time.
        </p>
      ) : (
        <ul className="space-y-2">
          {events.map((ev) => {
            const style = DECISION_STYLES[ev.decision] ?? DECISION_STYLES.allow;
            return (
              <li key={ev.id} className="flex items-start gap-3 text-sm">
                <span
                  className={`mt-1 h-2 w-2 shrink-0 rounded-full ${style.dot}`}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-mono text-zinc-200 truncate">
                      {ev.toolName}
                    </span>
                    <span
                      className={`rounded px-1.5 py-0.5 text-xs font-semibold uppercase ${style.badge}`}
                    >
                      {ev.decision}
                    </span>
                    <span className="text-xs text-zinc-500">
                      {(ev.divergence * 100).toFixed(1)}% divergence
                    </span>
                  </div>
                  {ev.agentIntent && (
                    <p className="text-xs text-zinc-500 truncate mt-0.5">
                      {ev.agentIntent}
                    </p>
                  )}
                </div>
                <span className="shrink-0 text-xs text-zinc-600">
                  {timeAgo(ev.timestamp)}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
