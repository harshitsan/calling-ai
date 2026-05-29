import { Slot } from './slot';
import { cva, type VariantProps } from 'class-variance-authority';
import * as React from 'react';
import { cn } from '@/lib/utils';

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-full text-[13px] font-medium tracking-tight transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-0 disabled:pointer-events-none disabled:opacity-40 active:scale-[0.985]',
  {
    variants: {
      variant: {
        default:
          'bg-foreground text-background hover:bg-foreground/90 shadow-[inset_0_1px_0_hsl(0_0%_100%/0.2),0_8px_20px_-8px_hsl(0_0%_0%/0.6)]',
        destructive:
          'bg-destructive/90 text-destructive-foreground hover:bg-destructive shadow-[inset_0_1px_0_hsl(0_0%_100%/0.15),0_8px_20px_-8px_hsl(0_70%_40%/0.5)]',
        outline:
          'border border-border bg-white/[0.02] hover:bg-white/[0.06] text-foreground/90',
        secondary:
          'bg-secondary text-secondary-foreground hover:bg-accent border border-border/60',
        ghost:
          'hover:bg-white/[0.05] text-foreground/80',
        link: 'text-primary underline-offset-4 hover:underline rounded-md',
      },
      size: {
        default: 'h-9 px-4',
        sm: 'h-8 px-3 text-xs',
        lg: 'h-11 px-6 text-sm',
        icon: 'h-9 w-9',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : 'button';
    return <Comp className={cn(buttonVariants({ variant, size, className }))} ref={ref} {...props} />;
  },
);
Button.displayName = 'Button';

export { Button, buttonVariants };
