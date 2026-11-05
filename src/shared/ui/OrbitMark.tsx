/** Sidebar, authentication and About share this theme-colored orbit-and-node brand mark. */
export function OrbitMark({ className = 'h-7 w-7' }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" fill="none" className={className} aria-hidden="true" data-orbit-mark>
      <circle cx="16" cy="16" r="8.5" stroke="currentColor" strokeWidth="1.5" opacity="0.48" />
      <ellipse cx="16" cy="16" rx="13" ry="6.5" transform="rotate(-36 16 16)" stroke="currentColor" strokeWidth="1.7" />
      <circle cx="16" cy="16" r="2.1" fill="currentColor" />
      <circle cx="26.5" cy="8.4" r="2.7" fill="currentColor" />
    </svg>
  );
}
