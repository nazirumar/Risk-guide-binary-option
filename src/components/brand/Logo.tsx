/**
 * RiskGuard brand mark — emerald shield with an upward trend line.
 *
 * Single source of truth for the in-app logo (sidebar, auth shell, landing
 * hero, offline page). The SVG favicons (`src/app/icon.svg`, `public/logo.svg`)
 * mirror this shape; regenerate PNG assets with `bun run icons`.
 */
export function Logo({
  className,
  title = "RiskGuard",
}: {
  className?: string;
  title?: string;
}) {
  return (
    <svg
      viewBox="0 0 64 64"
      className={className}
      role="img"
      aria-label={title}
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <linearGradient
          id="rgShield"
          x1="8"
          y1="4"
          x2="56"
          y2="60"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0" stopColor="#34d399" />
          <stop offset="1" stopColor="#047857" />
        </linearGradient>
      </defs>
      <path
        d="M32 4 56 12.5V30c0 14.4-10.1 25.6-24 30C18.1 55.6 8 44.4 8 30V12.5Z"
        fill="url(#rgShield)"
      />
      <path
        d="M17 40 25 32l6 5 14-14"
        fill="none"
        stroke="#ffffff"
        strokeWidth="5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M37 23h8v8"
        fill="none"
        stroke="#ffffff"
        strokeWidth="5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
