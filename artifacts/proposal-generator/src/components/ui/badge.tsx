import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const badgeVariants = cva(
  "whitespace-nowrap inline-flex items-center rounded-full border-0 bg-[#111111] px-3 py-1 text-[11px] font-semibold uppercase tracking-wider transition-colors focus:outline-none",
  {
    variants: {
      variant: {
        default: "text-[#0000FF]",
        secondary: "text-white",
        destructive: "text-[#FF8300]",
        success: "text-[#00FFD5]",
        tertiary: "text-[#FF40EE]",
        outline:
          "bg-transparent border border-[#333] text-[#999999] rounded-[4px]",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return (
    <div className={cn(badgeVariants({ variant }), className)} {...props} />
  )
}

export { Badge, badgeVariants }
