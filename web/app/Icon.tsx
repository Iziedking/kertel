import type { ReactNode } from "react";

type IconName = "arrow" | "check" | "moon" | "orbit" | "sun" | "waves";

export default function Icon({ name, className = "" }: { readonly name: IconName; readonly className?: string }) {
  const paths: Record<IconName, ReactNode> = {
    arrow: <><path d="M5 19 19 5" /><path d="M9 5h10v10" /></>,
    check: <path d="m5 12 4 4L19 6" />,
    moon: <path d="M20 15.2A8.5 8.5 0 0 1 8.8 4 8.5 8.5 0 1 0 20 15.2Z" />,
    orbit: <><circle cx="12" cy="12" r="3" /><ellipse cx="12" cy="12" rx="10" ry="4.5" transform="rotate(-28 12 12)" /></>,
    sun: <><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></>,
    waves: <><path d="M3 8c3-3 6 3 9 0s6 3 9 0" /><path d="M3 16c3-3 6 3 9 0s6 3 9 0" /></>,
  };
  return <svg className={`icon ${className}`.trim()} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}
