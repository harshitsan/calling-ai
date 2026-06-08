import Fastify, { type FastifyInstance } from 'fastify';
import type { SessionManager } from './session-manager';

export interface ServerDeps {
  manager: SessionManager;
  controlSecret: string;
}

export function buildServer(deps: ServerDeps): FastifyInstance {
  const app = Fastify({ logger: false });

  app.get('/healthz', async () => ({ ok: true }));

  app.addHook('preHandler', async (req, reply) => {
    if (req.url === '/healthz') return;
    const authz = req.headers.authorization;
    if (authz !== `Bearer ${deps.controlSecret}`) {
      reply.code(401).send({ error: 'unauthorized' });
    }
  });

  app.post('/recordings', async (req, reply) => {
    const body = (req.body ?? {}) as { meetingUrl?: unknown; title?: unknown };
    if (typeof body.meetingUrl !== 'string' || !body.meetingUrl) {
      return reply.code(400).send({ error: 'meetingUrl is required' });
    }
    const title = typeof body.title === 'string' ? body.title : null;
    try {
      const session = deps.manager.start(body.meetingUrl, title);
      return reply.code(201).send({ sessionId: session.id, status: session.status });
    } catch (e) {
      if ((e as Error).message === 'at capacity') {
        return reply.code(429).header('retry-after', '60').send({ error: 'at capacity' });
      }
      throw e;
    }
  });

  app.get('/recordings/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const s = deps.manager.get(id);
    if (!s) return reply.code(404).send({ error: 'not found' });
    return reply.send(s);
  });

  app.post('/recordings/:id/stop', async (req, reply) => {
    const { id } = req.params as { id: string };
    const ok = deps.manager.requestStop(id);
    if (!ok) return reply.code(404).send({ error: 'not found' });
    return reply.send({ ok: true });
  });

  return app;
}
