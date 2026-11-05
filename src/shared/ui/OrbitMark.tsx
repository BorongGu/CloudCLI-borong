/** Sidebar, authentication and About share this theme-colored orbit-and-node brand mark. */
export function OrbitMark({ className = 'h-7 w-7' }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" fill="none" className={className} aria-hidden="true" data-orbit-mark>
      {/* An offset inner arc gives the open ring a subtle optical taper. */}
      <path d="M27.13 14.04A11.3 11.3 0 1 1 17.96 4.87L18.03 6.83A8.8 8.8 0 1 0 25.17 13.97Z" fill="currentColor" />
      <circle cx="24.2" cy="7.8" r="2.2" fill="currentColor" />
    </svg>
  );
}
