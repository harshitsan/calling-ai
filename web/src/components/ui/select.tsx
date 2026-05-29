import * as React from 'react';
import { cn } from '@/lib/utils';

export const Select = React.forwardRef<HTMLSelectElement, React.SelectHTMLAttributes<HTMLSelectElement>>(
  ({ className, children, ...props }, ref) => (
    <select
      ref={ref}
      className={cn(
        'flex h-10 w-full appearance-none rounded-md bg-white/[0.03] border border-white/[0.07] px-3.5 pr-9 py-1 text-[13px] text-foreground/95',
        'shadow-[inset_0_1px_0_hsl(0_0%_100%/0.03)]',
        'bg-[url("data:image/svg+xml;utf8,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 viewBox=%270 0 24 24%27 fill=%27none%27 stroke=%27%23A3A0AC%27 stroke-width=%271.5%27%3E%3Cpath stroke-linecap=%27round%27 stroke-linejoin=%27round%27 d=%27m6 9 6 6 6-6%27/%3E%3C/svg%3E")] bg-no-repeat bg-[right_10px_center] bg-[length:14px_14px]',
        'transition-colors focus-visible:outline-none focus-visible:bg-white/[0.05] focus-visible:border-white/[0.18]',
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
