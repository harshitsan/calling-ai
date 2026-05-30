import * as React from 'react';
import { cn } from '@/lib/utils';

export const Select = React.forwardRef<HTMLSelectElement, React.SelectHTMLAttributes<HTMLSelectElement>>(
  ({ className, children, style, ...props }, ref) => (
    <select
      ref={ref}
      style={{
        backgroundColor: 'hsl(var(--card))',
        backgroundImage:
          "url(\"data:image/svg+xml;utf8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23A3A0AC' stroke-width='1.5'%3E%3Cpath stroke-linecap='round' stroke-linejoin='round' d='m6 9 6 6 6-6'/%3E%3C/svg%3E\")",
        backgroundRepeat: 'no-repeat',
        backgroundPosition: 'right 10px center',
        backgroundSize: '14px 14px',
        ...style,
      }}
      className={cn(
        'flex h-10 w-full appearance-none rounded-md border border-white/[0.07] px-3.5 pr-9 py-1 text-[13px] text-foreground/95',
        'shadow-[inset_0_1px_0_hsl(0_0%_100%/0.03)]',
        'transition-colors focus-visible:outline-none focus-visible:border-white/[0.18]',
        'disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    >
      {children}
    </select>
  ),
);
Select.displayName = 'Select';
