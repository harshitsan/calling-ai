import * as React from 'react';
import { cn } from '@/lib/utils';

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, type, ...props }, ref) => (
    <input
      type={type}
      ref={ref}
      className={cn(
        'flex h-10 w-full rounded-md bg-white/[0.03] border border-white/[0.07] px-3.5 py-1 text-[13px] text-foreground/95',
        'placeholder:text-muted-foreground/60 placeholder:font-light',
        'shadow-[inset_0_1px_0_hsl(0_0%_100%/0.03)]',
        'transition-colors focus-visible:outline-none focus-visible:bg-white/[0.05] focus-visible:border-white/[0.18]',
        'disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    />
  ),
);
Input.displayName = 'Input';
