import { lazy, Suspense } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { Layout } from './components/Layout';
import { getToken } from './lib/api';
import { NOTETAKER_ENABLED, VOICEOVERS_ENABLED, VOICE_INTEGRATIONS_ENABLED } from './lib/features';
import { Login } from './pages/Login';

// Code-split every page so the initial JS bundle only contains React, the
// router, the layout shell, and the login screen. Other pages load on
// navigation — typical first-paint drops from ~420 KB to ~100 KB of JS.
const Agents = lazy(() => import('./pages/Agents').then((m) => ({ default: m.Agents })));
const AgentForm = lazy(() => import('./pages/AgentForm').then((m) => ({ default: m.AgentForm })));
const Calls = lazy(() => import('./pages/Calls').then((m) => ({ default: m.Calls })));
const CallDetail = lazy(() => import('./pages/CallDetail').then((m) => ({ default: m.CallDetail })));
const TestCall = lazy(() => import('./pages/TestCall').then((m) => ({ default: m.TestCall })));
const Logs = lazy(() => import('./pages/Logs').then((m) => ({ default: m.Logs })));
const Voiceovers = lazy(() => import('./pages/Voiceovers').then((m) => ({ default: m.Voiceovers })));
const VoiceoverNew = lazy(() => import('./pages/VoiceoverNew').then((m) => ({ default: m.VoiceoverNew })));
const VoiceIntegrations = lazy(() => import('./pages/VoiceIntegrations').then((m) => ({ default: m.VoiceIntegrations })));
const TataSetup = lazy(() => import('./pages/TataSetup').then((m) => ({ default: m.TataSetup })));
const Notetaker = lazy(() => import('./pages/Notetaker').then((m) => ({ default: m.Notetaker })));
const NotetakerNew = lazy(() => import('./pages/NotetakerNew').then((m) => ({ default: m.NotetakerNew })));
const NotetakerDetail = lazy(() => import('./pages/NotetakerDetail').then((m) => ({ default: m.NotetakerDetail })));

function RequireAuth({ children }: { children: React.ReactNode }) {
  return getToken() ? <>{children}</> : <Navigate to="/login" replace />;
}

function PageFallback() {
  return (
    <div className="fade-up">
      <p className="text-sm text-muted-foreground italic font-display">Loading…</p>
    </div>
  );
}

export function App() {
  return (
    <BrowserRouter>
      <Suspense fallback={<PageFallback />}>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route
            element={
              <RequireAuth>
                <Layout />
              </RequireAuth>
            }
          >
            <Route path="/" element={<Navigate to="/agents" replace />} />
            <Route path="/agents" element={<Agents />} />
            <Route path="/agents/new" element={<AgentForm />} />
            <Route path="/agents/:id" element={<AgentForm />} />
            <Route path="/calls" element={<Calls />} />
            <Route path="/calls/:id" element={<CallDetail />} />
            <Route path="/test" element={<TestCall />} />
            <Route path="/logs" element={<Logs />} />
            {VOICEOVERS_ENABLED && (
              <>
                <Route path="/voiceovers" element={<Voiceovers />} />
                <Route path="/voiceovers/new" element={<VoiceoverNew />} />
              </>
            )}
            {VOICE_INTEGRATIONS_ENABLED && (
              <>
                <Route path="/integrations" element={<VoiceIntegrations />} />
                <Route path="/integrations/tata" element={<TataSetup />} />
              </>
            )}
            {NOTETAKER_ENABLED && (
              <>
                <Route path="/notetaker" element={<Notetaker />} />
                <Route path="/notetaker/new" element={<NotetakerNew />} />
                <Route path="/notetaker/:id" element={<NotetakerDetail />} />
              </>
            )}
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
    </BrowserRouter>
  );
}
