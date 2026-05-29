const TOKEN_KEY = 'calling_ai_token';

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}
export function setToken(t: string): void {
  localStorage.setItem(TOKEN_KEY, t);
}
export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

export async function api<T = unknown>(path: string, opts: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...((opts.headers as Record<string, string>) ?? {}),
  };
  const t = getToken();
  if (t) headers.authorization = `Bearer ${t}`;
  const res = await fetch(path, { ...opts, headers });
  if (!res.ok) {
    const e = (await res.json().catch(() => ({ error: res.statusText }))) as { error?: string };
    throw new Error(e.error ?? 'request failed');
  }
  return res.json() as Promise<T>;
}

export const AURA_VOICES = [
  'asteria', 'luna', 'stella', 'athena', 'hera',
  'orion', 'arcas', 'perseus', 'angus', 'orpheus', 'helios', 'zeus',
];
