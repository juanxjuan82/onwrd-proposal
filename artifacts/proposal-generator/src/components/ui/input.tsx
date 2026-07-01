import * as React from "react"

import { cn } from "@/lib/utils"

const Input = React.forwardRef<HTMLInputElement, React.ComponentProps<"input">>(
  ({ className, type, ...props }, ref) => {
    return (
      <input
        type={type}
        className={cn(
          "flex h-10 w-full bg-transparent border-0 border-b border-[#333333] rounded-none px-0 py-2 text-sm text-white",
          "placeholder:text-[#555] transition-colors",
          "focus:outline-none focus-visible:outline-none focus:border-[#0000FF] focus-visible:border-[#0000FF]",
          "disabled:cursor-not-allowed disabled:opacity-50",
          "file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-white",
          className
        )}
        ref={ref}
        {...props}
      />
    )
  }
)
Input.displayName = "Input"

export { Input }
