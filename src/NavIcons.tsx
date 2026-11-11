import type { ReactNode } from 'react';

// Navigation icons share one 24×24 grid and stroke so they render at the same
// size and weight on every device and follow the surrounding text colour.
function NavIcon({ children }: { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="1em"
      height="1em"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

// The Log icon replaces ◷, which is missing from some phone fonts and was drawn
// smaller by the fallback font.
export function LogIcon() {
  return (
    <NavIcon>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </NavIcon>
  );
}

export function PlanIcon() {
  return (
    <NavIcon>
      <path d="M3 3v18h18Z" />
      <path d="M7 11v6h6Z" />
      <path d="M3 8h2M3 13h2M11 21v-2M16 21v-2" />
    </NavIcon>
  );
}

export function ShoppingIcon() {
  return (
    <NavIcon>
      <path d="M2 3h3l2.6 11.4a1 1 0 0 0 1 .8h9.2a1 1 0 0 0 1-.8L21 7H6" />
      <circle cx="9" cy="19.5" r="1.5" />
      <circle cx="17" cy="19.5" r="1.5" />
    </NavIcon>
  );
}

export function SettingsIcon() {
  return (
    <NavIcon>
      <path d="M9.78 5.15 9.96 2.72h4.08l.18 2.43 1.05.43L17.12 4 20 6.88l-1.58 1.85.43 1.05 2.43.18v4.08l-2.43.18-.43 1.05L20 17.12 17.12 20l-1.85-1.58-1.05.43-.18 2.43H9.96l-.18-2.43-1.05-.43L6.88 20 4 17.12l1.58-1.85-.43-1.05-2.43-.18V9.96l2.43-.18.43-1.05L4 6.88 6.88 4l1.85 1.58Z" />
      <circle cx="12" cy="12" r="3" />
    </NavIcon>
  );
}
