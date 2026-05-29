import { zodResolver } from '@hookform/resolvers/zod';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { useNavigate } from 'react-router-dom';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { api, setToken } from '@/lib/api';

const schema = z.object({
  tenantName: z.string().optional(),
  email: z.string().email('valid email required'),
  password: z.string().min(1, 'password required'),
});
type FormValues = z.infer<typeof schema>;

export function Login() {
  const navigate = useNavigate();
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [error, setError] = useState('');
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({ resolver: zodResolver(schema) });

  async function onSubmit(values: FormValues) {
    setError('');
    try {
      const path = mode === 'login' ? '/api/auth/login' : '/api/auth/register';
      const body =
        mode === 'login'
          ? { email: values.email, password: values.password }
          : { email: values.email, password: values.password, tenantName: values.tenantName || 'My Workspace' };
      const res = await api<{ token: string }>(path, { method: 'POST', body: JSON.stringify(body) });
      setToken(res.token);
      navigate('/agents');
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-6">
      <div className="w-full max-w-[440px] fade-up">
        <div className="text-center mb-10">
          <div className="font-display text-6xl leading-none tracking-tight text-foreground/95">
            calling<span className="text-aurora">.</span>
            <span className="italic text-aurora">ai</span>
          </div>
          <p className="mt-5 text-[13px] text-muted-foreground italic font-display">
            {mode === 'login' ? 'Welcome back.' : 'Begin something quiet and exceptional.'}
          </p>
        </div>

        <div className="glass rounded-2xl p-8 stagger">
          <form onSubmit={handleSubmit(onSubmit)} className="space-y-5">
            {mode === 'register' && (
              <div className="space-y-2">
                <Label>Workspace</Label>
                <Input placeholder="Aurora Studio" {...register('tenantName')} />
              </div>
            )}
            <div className="space-y-2">
              <Label>Email</Label>
              <Input type="email" placeholder="you@elsewhere.com" {...register('email')} />
              {errors.email && <p className="text-xs text-destructive/90">{errors.email.message}</p>}
            </div>
            <div className="space-y-2">
              <Label>Password</Label>
              <Input type="password" placeholder="••••••••" {...register('password')} />
              {errors.password && <p className="text-xs text-destructive/90">{errors.password.message}</p>}
            </div>
            {error && <p className="text-sm text-destructive/90">{error}</p>}
            <Button type="submit" size="lg" className="w-full" disabled={isSubmitting}>
              {isSubmitting ? 'A moment…' : mode === 'login' ? 'Enter' : 'Create workspace'}
            </Button>
          </form>
          <div className="hairline my-6" />
          <button
            type="button"
            className="w-full text-center text-[12px] text-muted-foreground hover:text-foreground/90 transition-colors"
            onClick={() => setMode(mode === 'login' ? 'register' : 'login')}
          >
            {mode === 'login' ? 'No account yet? Create a workspace →' : 'Already with us? Sign in →'}
          </button>
        </div>

        <p className="text-center mt-8 text-[10px] uppercase tracking-[0.24em] text-muted-foreground/60">
          a quieter way to call
        </p>
      </div>
    </div>
  );
}
