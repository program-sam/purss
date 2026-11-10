import type { ButtonHTMLAttributes, ReactNode } from "react";
import { forwardRef } from "react";

type Variant = "default" | "primary" | "ghost" | "danger";

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; large?: boolean };

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button({ variant = "default", large, className = "", type = "button", ...rest }, ref) {
  const cls = ["btn", variant === "primary" ? "primary" : "", variant === "ghost" ? "ghost" : "", variant === "danger" ? "dangerb" : "", large ? "lg" : "", className].filter(Boolean).join(" ");
  return <button ref={ref} type={type} className={cls} data-cuelume-tap="" {...rest} />;
});

export const IconButton = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { label: string; children: ReactNode }>(
  function IconButton({ label, className = "", type = "button", children, ...rest }, ref) {
    return <button ref={ref} type={type} className={`ibtn ${className}`.trim()} aria-label={label} data-cuelume-tap="" {...rest}>{children}</button>;
  },
);
