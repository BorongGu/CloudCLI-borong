/** Sidebar, authentication and About share this theme-colored orbit-and-node brand mark. */
export function OrbitMark({ className = 'h-7 w-7' }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" fill="none" className={className} aria-hidden="true" data-orbit-mark>
      {/* Rear arcs stay translucent; the foreground passes give the tilted rings depth. */}
      <g transform="rotate(-30 16 16)" stroke="currentColor" strokeWidth="2.9" strokeLinecap="round">
        <ellipse cx="16" cy="16" rx="10.5" ry="11.7" opacity="0.3" />
        <ellipse cx="16" cy="16" rx="11.7" ry="5.5" opacity="0.58" />
        <path d="M4.3 16a11.7 5.5 0 0 0 23.4 0" />
        <path d="M16 4.3a10.5 11.7 0 0 1 0 23.4" />
      </g>
      <circle cx="6.3" cy="10.2" r="2.7" fill="currentColor" />
    </svg>
  );
}
