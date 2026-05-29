import { Bot, LogOut, Phone, PhoneCall } from 'lucide-react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { Button } from './ui/button';
import { clearToken } from '@/lib/api';
import { cn } from '@/lib/utils';

const nav = [
  { to: '/agents', label: 'Agents', icon: Bot },
  { to: '/calls', label: 'Call Logs', icon: Phone },
  { to: '/test', label: 'Test Call', icon: PhoneCall },
];

export function Layout() {
  const navigate = useNavigate();
  return (
    <div className="flex min-h-screen">
      <aside className="w-60 shrink-0 border-r bg-muted/30 p-4 flex flex-col">
        <div className="font-semibold text-lg px-2 py-3">calling-ai</div>
        <nav className="flex flex-col gap-1 mt-2">
          {nav.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              className={({ isActive }) =>
                cn(
                  'flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors',
                  isActive ? 'bg-primary text-primary-foreground' : 'hover:bg-accent',
                )
              }
            >
              <n.icon className="h-4 w-4" />
              {n.label}
            </NavLink>
          ))}
        </nav>
        <div className="mt-auto">
          <Button
            variant="ghost"
            className="w-full justify-start"
            onClick={() => {
              clearToken();
              navigate('/login');
            }}
          >
            <LogOut className="h-4 w-4" /> Sign out
          </Button>
        </div>
      </aside>
      <main className="flex-1 p-8 max-w-5xl">
        <Outlet />
      </main>
    </div>
  );
}
