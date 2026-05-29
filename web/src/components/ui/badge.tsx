import * as React from 'react';
import { cn } from '@/lib/utils';

export function Badge({ className, ...props }: React.HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full border border-white/[0.07] bg-white/[0.04] px-2 py-0.5 text-[10px] font-medium tracking-wide uppercase text-foreground/75',
        className,
      )}
      {...props}
    />
  );
}
