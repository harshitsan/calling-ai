import * as React from 'react';
import { cn } from '@/lib/utils';

export const Textarea = React.forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement>
>(({ className, ...props }, ref) => (
  <textarea
    ref={ref}
    className={cn(
      'flex min-h-[90px] w-full rounded-md bg-white/[0.03] border border-white/[0.07] px-3.5 py-2.5 text-[13px] text-foreground/95',
      'placeholder:text-muted-foreground/60 placeholder:font-light',
      'shadow-[inset_0_1px_0_hsl(0_0%_100%/0.03)]',
      'transition-colors focus-visible:outline-none focus-visible:bg-white/[0.05] focus-visible:border-white/[0.18]',
      'disabled:cursor-not-allowed disabled:opacity-50 resize-none',
      className,
    )}
    {...props}
  />
));
Textarea.displayName = 'Textarea';
