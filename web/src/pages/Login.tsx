import { zodResolver } from '@hookform/resolvers/zod';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { useNavigate } from 'react-router-dom';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
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
    <div className="min-h-screen flex items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>calling-ai</CardTitle>
          <CardDescription>{mode === 'login' ? 'Sign in to your workspace' : 'Create a workspace'}</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
            {mode === 'register' && (
              <div className="space-y-1">
                <Label>Workspace name</Label>
                <Input placeholder="Acme Inc" {...register('tenantName')} />
              </div>
            )}
            <div className="space-y-1">
              <Label>Email</Label>
              <Input type="email" placeholder="you@company.com" {...register('email')} />
              {errors.email && <p className="text-xs text-destructive">{errors.email.message}</p>}
            </div>
            <div className="space-y-1">
              <Label>Password</Label>
              <Input type="password" placeholder="••••••••" {...register('password')} />
              {errors.password && <p className="text-xs text-destructive">{errors.password.message}</p>}
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
            <Button type="submit" className="w-full" disabled={isSubmitting}>
              {isSubmitting ? 'Please wait…' : mode === 'login' ? 'Sign in' : 'Create workspace'}
            </Button>
          </form>
          <button
            className="mt-4 text-sm text-muted-foreground hover:underline"
            onClick={() => setMode(mode === 'login' ? 'register' : 'login')}
          >
            {mode === 'login' ? "Don't have an account? Register" : 'Already have an account? Sign in'}
          </button>
        </CardContent>
      </Card>
    </div>
  );
}
