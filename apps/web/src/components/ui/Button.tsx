import type { ButtonHTMLAttributes } from "react";

type Variant = "primary" | "accent" | "secondary" | "danger";

const STYLE: Record<Variant, string> = {
  primary: "bg-forest text-white border-forest hover:bg-forest-deep",
  accent: "bg-orange text-white border-orange hover:brightness-95",
  secondary: "bg-white text-ink border-[#D3DAD5] hover:bg-page",
  danger: "bg-warn-ink text-white border-warn-ink hover:brightness-95",
};

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  /** Full-width, 48px tall — the shape used in the parent and student apps. */
  block?: boolean;
}

export function Button({ variant = "secondary", block, className = "", ...rest }: Props) {
  return (
    <button
      {...rest}
      className={[
        "rounded-md border font-sans text-[12.5px] transition disabled:cursor-not-allowed disabled:opacity-50",
        block ? "hit w-full px-4 py-3.5 text-[15px] font-semibold" : "px-3.5 py-2",
        variant === "primary" || variant === "accent" ? "font-semibold" : "",
        STYLE[variant],
        className,
      ].join(" ")}
    />
  );
}
