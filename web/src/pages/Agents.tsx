import { Plus, Sparkles } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { api } from '@/lib/api';

interface Agent {
  id: string;
  name: string;
  voice: string;
  role?: string;
}

export function Agents() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api<{ agents: Agent[] }>('/api/agents')
      .then((r) => setAgents(r.agents))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="fade-up">
      <header className="mb-10">
        <div className="text-[11px] uppercase tracking-[0.22em] text-muted-foreground/80 mb-3">
          Workspace · Agents
        </div>
        <div className="flex items-end justify-between gap-6">
          <h1 className="font-display text-6xl tracking-tight leading-[0.95]">
            Your <span className="italic text-aurora">cast</span>
          </h1>
          <Button asChild>
            <Link to="/agents/new">
              <Plus className="h-4 w-4" /> New agent
            </Link>
          </Button>
        </div>
        <p className="mt-4 text-[13px] text-muted-foreground max-w-md leading-relaxed">
          Each agent is a voice, a memory, a way of being on the phone.
        </p>
      </header>

      {loading ? (
        <p className="text-sm text-muted-foreground italic font-display">Loading…</p>
      ) : agents.length === 0 ? (
        <Card className="py-20 text-center">
          <Sparkles className="mx-auto h-6 w-6 text-aurora-2 opacity-70" />
          <p className="mt-4 font-display italic text-xl text-foreground/90">A blank stage awaits.</p>
          <p className="text-sm text-muted-foreground mt-1">Compose your first agent to begin.</p>
          <div className="mt-6">
            <Button asChild>
              <Link to="/agents/new"><Plus className="h-4 w-4" /> Create agent</Link>
            </Button>
          </div>
        </Card>
      ) : (
        <div className="grid gap-5 sm:grid-cols-2 stagger">
          {agents.map((a) => (
            <Link key={a.id} to={`/agents/${a.id}`} className="group">
              <Card className="p-6 hover:-translate-y-0.5 transition-transform duration-300">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <h3 className="font-display text-2xl tracking-tight truncate text-foreground/95 group-hover:text-aurora transition-colors">
                      {a.name}
                    </h3>
                    <p className="mt-1 text-[13px] text-muted-foreground truncate">
                      {a.role || 'No role set'}
                    </p>
                  </div>
                  <Badge>{a.voice}</Badge>
                </div>
                <div className="hairline my-5" />
                <div className="flex items-center justify-between text-[11px] uppercase tracking-[0.18em] text-muted-foreground/70">
                  <span>edit & deploy</span>
                  <span className="opacity-60 group-hover:opacity-100 group-hover:translate-x-1 transition-all">→</span>
                </div>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
