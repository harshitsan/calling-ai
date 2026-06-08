import { loadConfig } from './config';
import { SessionStore } from './store';
import { SessionManager } from './session-manager';
import { buildServer } from './server';
import { makeRunner } from './runner';
import { randomUUID } from 'node:crypto';

const config = loadConfig();
const store = new SessionStore(config.dbPath);
store.markInterrupted(Date.now());

const manager = new SessionManager({
  maxConcurrent: config.maxConcurrent,
  runner: makeRunner(config),
  idFactory: () => randomUUID(),
  now: () => Date.now(),
  onChange: (s) => store.upsert(s),
});

const app = buildServer({ manager, controlSecret: config.controlSecret });
app.listen({ port: config.port, host: '0.0.0.0' }).then(() => {
  console.log(`[meeting-recorder] listening on :${config.port}`);
});
