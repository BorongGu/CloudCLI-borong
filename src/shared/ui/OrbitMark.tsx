import { useId } from 'react';

// Filled contours make the foreground broad and taper the distant ends of each orbit.
const FRONT_MERIDIAN = "M16 4.65C17.83 4.65 19.72 4.94 21.45 5.83C23.18 6.72 24.74 8.13 25.83 9.92C26.92 11.71 27.52 13.85 27.52 16C27.52 18.15 26.92 20.29 25.83 22.08C24.74 23.87 23.18 25.28 21.45 26.17C19.72 27.06 17.83 27.35 16 27.35L16 26.85C17.73 26.85 19.4 26.11 20.75 25.06C22.1 24.01 23.14 22.59 23.84 21.02C24.53 19.45 24.88 17.72 24.88 16C24.88 14.28 24.53 12.55 23.84 10.98C23.14 9.41 22.1 7.99 20.75 6.94C19.4 5.89 17.73 5.15 16 5.15Z";

/** Sidebar, authentication and About share this theme-colored orbit-and-node brand mark. */
export function OrbitMark({ className = 'h-7 w-7' }: { className?: string }) {
  const crossingMaskId = useId();
  return (
    <svg viewBox="0 0 32 32" fill="none" className={className} aria-hidden="true" data-orbit-mark>
      <defs>
        <mask id={crossingMaskId} maskUnits="userSpaceOnUse" x="0" y="0" width="32" height="32">
          <rect width="32" height="32" fill="white" />
          <path d={FRONT_MERIDIAN} fill="black" stroke="black" strokeWidth="0.65" strokeLinejoin="round" />
        </mask>
      </defs>
      <g transform="rotate(-30 16 16)" fill="currentColor">
        <path d="M16 27.35C14.17 27.35 12.33 26.89 10.7 25.93C9.07 24.97 7.67 23.53 6.71 21.79C5.75 20.06 5.23 18.03 5.23 16C5.23 13.97 5.75 11.94 6.71 10.21C7.67 8.47 9.07 7.03 10.7 6.07C12.33 5.11 14.17 4.65 16 4.65L16 5.15C14.27 5.15 12.56 5.73 11.1 6.7C9.64 7.68 8.44 9.07 7.62 10.69C6.81 12.31 6.38 14.15 6.38 16C6.38 17.85 6.81 19.69 7.62 21.31C8.44 22.93 9.64 24.32 11.1 25.3C12.56 26.27 14.27 26.85 16 26.85Z" opacity="0.28" />
        {/* The gap at the crossing separates the near ribbon from the orbit passing behind it. */}
        <g mask={`url(#${crossingMaskId})`}>
          <path d="M4.05 16C4.05 14.92 4.6 13.82 5.65 12.89C6.69 11.95 8.22 11.16 10.03 10.63C11.83 10.09 13.92 9.8 16 9.8C18.08 9.8 20.17 10.09 21.97 10.63C23.78 11.16 25.31 11.95 26.35 12.89C27.4 13.82 27.95 14.92 27.95 16L27.45 16C27.45 15.09 26.9 14.2 25.91 13.41C24.92 12.63 23.46 11.96 21.73 11.5C20 11.04 18 10.8 16 10.8C14 10.8 12 11.04 10.27 11.5C8.54 11.96 7.08 12.63 6.09 13.41C5.1 14.2 4.55 15.09 4.55 16Z" opacity="0.48" />
          <path d="M27.95 16C27.95 17.08 27.52 18.25 26.5 19.29C25.48 20.33 23.94 21.23 22.11 21.85C20.27 22.46 18.14 22.8 16 22.8C13.86 22.8 11.73 22.46 9.89 21.85C8.06 21.23 6.52 20.33 5.5 19.29C4.48 18.25 4.05 17.08 4.05 16L4.55 16C4.55 16.91 5.21 17.73 6.24 18.41C7.26 19.1 8.71 19.65 10.41 20.03C12.11 20.4 14.05 20.6 16 20.6C17.95 20.6 19.89 20.4 21.59 20.03C23.29 19.65 24.74 19.1 25.76 18.41C26.79 17.73 27.45 16.91 27.45 16Z" />
        </g>
        <path d={FRONT_MERIDIAN} />
      </g>
      <circle cx="6.3" cy="10.2" r="1.75" fill="currentColor" />
    </svg>
  );
}
