import { useEffect, useRef, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { getToken } from '@/lib/api';

interface LogEvent {
  ts: number;
  service: string;
  level?: 'info' | 'warn' | 'error';
  msg: string;
  data?: Record<string, unknown>;
  callId?: string;
}

const SERVICE_COLOR: Record<string, string> = {
  call: 'bg-violet-100 text-violet-700',
  stt: 'bg-blue-100 text-blue-700',
  llm: 'bg-emerald-100 text-emerald-700',
  tts: 'bg-amber-100 text-amber-700',
  memory: 'bg-pink-100 text-pink-700',
  tool: 'bg-cyan-100 text-cyan-700',
  webhook: 'bg-indigo-100 text-indigo-700',
  auth: 'bg-slate-100 text-slate-700',
  system: 'bg-slate-100 text-slate-700',
};

const SERVICES = ['call', 'stt', 'llm', 'tts', 'memory', 'tool', 'webhook'];

export function Logs() {
  const [events, setEvents] = useState<LogEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const [filter, setFilter] = useState<Set<string>>(new Set());
  const [autoscroll, setAutoscroll] = useState(true);
  const [issuesOnly, setIssuesOnly] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const token = getToken();
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/logs?token=${encodeURIComponent(token ?? '')}`);
    ws.onopen = () => setConnected(true);
    ws.onclose = () => setConnected(false);
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.type === 'history') setEvents(m.events ?? []);
      else if (m.type === 'log') setEvents((prev) => [...prev.slice(-500), m.event]);
    };
    wsRef.current = ws;
    return () => ws.close();
  }, []);

  useEffect(() => {
    if (autoscroll) bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [events, autoscroll]);

  const errorCount = events.filter((e) => e.level === 'error').length;
  const warnCount = events.filter((e) => e.level === 'warn').length;
  const shown = events.filter(
    (e) =>
      (filter.size === 0 || filter.has(e.service)) &&
      (!issuesOnly || e.level === 'error' || e.level === 'warn'),
  );

  function toggle(s: string) {
    setFilter((prev) => {
      const next = new Set(prev);
      next.has(s) ? next.delete(s) : next.add(s);
      return next;
    });
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Realtime Logs</h1>
        <div className="flex items-center gap-3 text-sm">
          {errorCount > 0 && (
            <Badge className="bg-red-100 text-red-700">{errorCount} error{errorCount > 1 ? 's' : ''}</Badge>
          )}
          {warnCount > 0 && (
            <Badge className="bg-amber-100 text-amber-700">{warnCount} warning{warnCount > 1 ? 's' : ''}</Badge>
          )}
          <span className="flex items-center gap-2 text-muted-foreground">
            <span className={`h-2.5 w-2.5 rounded-full ${connected ? 'bg-emerald-500 animate-pulse' : 'bg-red-500'}`} />
            {connected ? 'streaming' : 'disconnected'}
          </span>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {SERVICES.map((s) => (
          <button
            key={s}
            onClick={() => toggle(s)}
            className={`rounded-md border px-2 py-1 text-xs ${filter.has(s) || filter.size === 0 ? 'opacity-100' : 'opacity-40'} ${SERVICE_COLOR[s] ?? ''}`}
          >
            {s}
          </button>
        ))}
        <div className="ml-auto flex gap-2">
          <Button
            variant={issuesOnly ? 'destructive' : 'outline'}
            size="sm"
            onClick={() => setIssuesOnly((v) => !v)}
          >
            issues only
          </Button>
          <Button variant="outline" size="sm" onClick={() => setAutoscroll((a) => !a)}>
            autoscroll: {autoscroll ? 'on' : 'off'}
          </Button>
          <Button variant="outline" size="sm" onClick={() => setEvents([])}>
            clear
          </Button>
        </div>
      </div>

      <Card>
        <CardContent className="p-0">
          <div className="h-[60vh] overflow-y-auto font-mono text-xs p-3 space-y-1">
            {shown.length === 0 && (
              <p className="text-muted-foreground">
                Waiting for events… start a Test Call in another tab and watch them stream here.
              </p>
            )}
            {shown.map((e, i) => (
              <div
                key={i}
                className={`flex gap-2 items-start rounded px-1 ${
                  e.level === 'error'
                    ? 'bg-red-50 border-l-2 border-red-400'
                    : e.level === 'warn'
                      ? 'bg-amber-50 border-l-2 border-amber-400'
                      : ''
                }`}
              >
                <span className="text-muted-foreground shrink-0">
                  {new Date(e.ts).toLocaleTimeString([], { hour12: false })}
                </span>
                <Badge className={`shrink-0 ${SERVICE_COLOR[e.service] ?? ''}`}>{e.service}</Badge>
                {(e.level === 'error' || e.level === 'warn') && (
                  <Badge className={`shrink-0 ${e.level === 'error' ? 'bg-red-100 text-red-700' : 'bg-amber-100 text-amber-700'}`}>
                    {e.level}
                  </Badge>
                )}
                <span className={e.level === 'error' ? 'text-red-700' : e.level === 'warn' ? 'text-amber-700' : ''}>
                  {e.msg}
                  {e.data && Object.keys(e.data).length > 0 && (
                    <span className="opacity-70"> {JSON.stringify(e.data)}</span>
                  )}
                </span>
              </div>
            ))}
            <div ref={bottomRef} />
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
