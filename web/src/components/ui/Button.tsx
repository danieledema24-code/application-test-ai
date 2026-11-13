import Link from "next/link";
import { Loader2 } from "lucide-react";
import { forwardRef } from "react";

type Variant = "primary" | "secondary" | "ghost" | "danger" | "success";
type Size = "sm" | "md" | "lg";

const VARIANTS: Record<Variant, string> = {
  primary: "bg-accent text-on-accent font-semibold hover:bg-accent-hover active:bg-navy-900 shadow-xs disabled:bg-overlay disabled:text-fg-muted disabled:shadow-none",
  secondary: "bg-surface text-fg-strong ring-1 ring-inset ring-line-input hover:bg-overlay disabled:text-fg-muted disabled:hover:bg-surface",
  ghost: "text-fg-strong hover:bg-overlay disabled:text-fg-muted",
  danger: "bg-danger-solid text-white font-semibold hover:bg-danger-fg shadow-xs disabled:opacity-50 disabled:hover:bg-danger-solid",
  success: "bg-success-solid text-white font-semibold hover:bg-success-fg shadow-xs disabled:opacity-50 disabled:hover:bg-success-solid",
};
const SIZES: Record<Size, string> = {
  sm: "h-8 px-2.5 text-small gap-1.5 pointer-coarse:min-h-11",
  md: "h-10 px-4 text-body gap-2 pointer-coarse:min-h-11",
  lg: "h-12 px-5 text-body-lg gap-2",
};

export function buttonClass(variant: Variant = "primary", size: Size = "md", className = "") {
  return `inline-flex items-center justify-center rounded-md font-medium transition-colors duration-150 ease-out disabled:cursor-not-allowed focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus ${VARIANTS[variant]} ${SIZES[size]} ${className}`;
}

type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  icon?: React.ReactNode;
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "primary", size = "md", loading, icon, className = "", children, disabled, type = "button", ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={buttonClass(variant, size, className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden /> : icon}
      {children}
    </button>
  );
});

export function LinkButton({
  href,
  variant = "secondary",
  size = "md",
  icon,
  children,
  className = "",
  ...rest
}: { href: string; variant?: Variant; size?: Size; icon?: React.ReactNode; children: React.ReactNode; className?: string } & Omit<
  React.AnchorHTMLAttributes<HTMLAnchorElement>,
  "href"
>) {
  return (
    <Link href={href} className={buttonClass(variant, size, className)} {...rest}>
      {icon}
      {children}
    </Link>
  );
}
