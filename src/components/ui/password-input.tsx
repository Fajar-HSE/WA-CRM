"use client"

import * as React from "react"
import { Eye, EyeOff } from "lucide-react"
import { useTranslations } from "next-intl"

import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"

type PasswordInputProps = Omit<React.ComponentProps<typeof Input>, "type">

/**
 * Password field with an eye button that reveals / hides the text.
 * Drop-in for `<Input type="password" />`; every other prop passes through.
 */
function PasswordInput({ className, ...props }: PasswordInputProps) {
  const t = useTranslations("PasswordInput")
  const [visible, setVisible] = React.useState(false)
  const label = visible ? t("hide") : t("show")

  return (
    <div className="relative">
      <Input
        {...props}
        type={visible ? "text" : "password"}
        className={cn("pr-10", className)}
      />
      <button
        type="button"
        onClick={() => setVisible((v) => !v)}
        aria-label={label}
        aria-pressed={visible}
        title={label}
        disabled={props.disabled}
        className="absolute inset-y-0 right-0 flex w-10 items-center justify-center rounded-r-lg text-muted-foreground transition-colors hover:text-foreground focus-visible:text-foreground focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50"
      >
        {visible ? (
          <EyeOff className="h-4 w-4" aria-hidden="true" />
        ) : (
          <Eye className="h-4 w-4" aria-hidden="true" />
        )}
      </button>
    </div>
  )
}

export { PasswordInput }
