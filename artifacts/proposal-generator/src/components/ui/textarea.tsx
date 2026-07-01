import * as React from "react"

import { cn } from "@/lib/utils"

const Textarea = React.forwardRef<
  HTMLTextAreaElement,
  React.ComponentProps<"textarea">
>(({ className, ...props }, ref) => {
  return (
    <textarea
      className={cn(
        "flex min-h-[80px] w-full bg-transparent border-0 border-b border-[#333333] rounded-none px-0 py-2 text-sm text-white",
        "placeholder:text-[#555] transition-colors",
        "focus:outline-none focus-visible:outline-none focus:border-[#0000FF] focus-visible:border-[#0000FF]",
        "disabled:cursor-not-allowed disabled:opacity-50",
        className
      )}
      ref={ref}
      {...props}
    />
  )
})
Textarea.displayName = "Textarea"

export { Textarea }
