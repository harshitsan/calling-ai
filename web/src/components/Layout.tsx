import { Bot, LogOut, Phone, PhoneCall, ScrollText } from 'lucide-react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { clearToken } from '@/lib/api';
import { cn } from '@/lib/utils';

const nav = [
  { to: '/agents', label: 'Agents', icon: Bot },
  { to: '/calls', label: 'Call Logs', icon: Phone },
  { to: '/test', label: 'Test Call', icon: PhoneCall },
  { to: '/logs', label: 'Live Logs', icon: ScrollText },
];

export function Layout() {
  const navigate = useNavigate();
  return (
    <div className="flex min-h-screen">
      <aside className="w-[260px] shrink-0 sticky top-0 h-screen p-5 flex flex-col gap-6 border-r border-white/[0.05]">
        <div className="px-2 pt-3">
          <div className="font-display text-[28px] leading-none text-foreground/95 tracking-tight">
            calling<span className="text-aurora">.</span>
            <span className="italic font-display text-aurora">ai</span>
          </div>
          <div className="mt-1.5 text-[10px] uppercase tracking-[0.22em] text-muted-foreground/80">
            voice intelligence
          </div>
        </div>

        <div className="hairline mx-1" />

        <nav className="flex flex-col gap-1">
          {nav.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              className={({ isActive }) =>
                cn(
                  'group relative flex items-center gap-3 rounded-xl px-3 py-2.5 text-[13px] transition-all duration-200',
                  isActive
                    ? 'bg-white/[0.06] text-foreground border border-white/[0.08] shadow-[inset_0_1px_0_hsl(0_0%_100%/0.05)]'
                    : 'text-muted-foreground hover:text-foreground/95 hover:bg-white/[0.03]',
                )
              }
            >
              {({ isActive }) => (
                <>
                  {isActive && (
                    <span className="absolute left-0 top-1/2 -translate-y-1/2 h-5 w-[2px] rounded-full bg-gradient-to-b from-aurora-1 to-aurora-2" />
                  )}
                  <n.icon className="h-[15px] w-[15px] opacity-80" />
                  <span className="tracking-tight">{n.label}</span>
                </>
              )}
            </NavLink>
          ))}
        </nav>

        <div className="mt-auto">
          <div className="hairline mx-1 mb-3" />
          <button
            onClick={() => {
              clearToken();
              navigate('/login');
            }}
            className="flex w-full items-center gap-2 rounded-xl px-3 py-2.5 text-[12px] text-muted-foreground hover:text-foreground hover:bg-white/[0.03] transition-colors"
          >
            <LogOut className="h-[14px] w-[14px]" /> Sign out
          </button>
        </div>
      </aside>

      <main className="flex-1 px-10 lg:px-14 py-12 max-w-[1200px]">
        <Outlet />
      </main>
    </div>
  );
}
