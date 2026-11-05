import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { CakeSlice, Check, Moon, Palette } from 'lucide-react';
import '@/modules/guest-chat/guest-themes.css';

type GuestTheme = 'dark' | 'cream';
const STORAGE_KEY = 'guest-theme';

function readTheme(): GuestTheme {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    return saved === 'cream' || (saved === null && document.documentElement.dataset.guestTheme === 'cream') ? 'cream' : 'dark';
  }
  catch { return document.documentElement.dataset.guestTheme === 'cream' ? 'cream' : 'dark'; }
}

/** GuestChat offers the same local appearance choice on its login page and conversation header. */
export function GuestThemePicker() {
  // The guest preference is independent of the company workspace's account settings.
  const [theme, setTheme] = useState<GuestTheme>(readTheme);
  // Keep the compact choice panel open only while the user is interacting with it.
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menuId = useId();

  useLayoutEffect(() => {
    document.documentElement.dataset.guestTheme = theme;
    document.documentElement.classList.toggle('dark', theme === 'dark');
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#111318' : '#faf7f0');
  }, [theme]);

  useEffect(() => {
    const sync = (event: StorageEvent) => { if (event.key === STORAGE_KEY || event.key === null) setTheme(event.newValue === 'cream' ? 'cream' : 'dark'); };
    window.addEventListener('storage', sync);return () => window.removeEventListener('storage', sync);
  }, []);

  useEffect(() => {
    if (!open) return;
    root.current?.querySelector<HTMLButtonElement>('[aria-pressed="true"]')?.focus({ preventScroll: true });
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { setOpen(false);trigger.current?.focus({ preventScroll: true }); }
    };
    document.addEventListener('pointerdown', outside);document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', outside);document.removeEventListener('keydown', escape); };
  }, [open]);

  function choose(next: GuestTheme) {
    setTheme(next);try { localStorage.setItem(STORAGE_KEY, next); } catch { /* The selected appearance still works for this page. */ }
    setOpen(false);trigger.current?.focus({ preventScroll: true });
  }

  return <div ref={root} className="guest-theme-picker" onBlur={event => { if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget as Node)) setOpen(false); }}>
    <button ref={trigger} type="button" className="guest-theme-trigger" aria-label="选择配色" title={`配色 · ${theme === 'cream' ? '奶油蛋糕' : '暗黑'}`} aria-expanded={open} aria-controls={menuId} onClick={() => setOpen(value => !value)}><Palette size={17} /></button>
    {open && <div id={menuId} className="guest-theme-menu" role="group" aria-label="界面配色">
      <p className="guest-theme-caption">选一种心情</p>
      <button type="button" className="guest-theme-choice" aria-pressed={theme === 'dark'} onClick={() => choose('dark')}>
        <span className="guest-theme-swatch night"><Moon size={17} /></span><span className="guest-theme-label">暗黑<small>静谧夜色</small></span>{theme === 'dark' && <Check size={14} />}
      </button>
      <button type="button" className="guest-theme-choice" aria-pressed={theme === 'cream'} onClick={() => choose('cream')}>
        <span className="guest-theme-swatch cake"><CakeSlice size={17} /></span><span className="guest-theme-label">奶油蛋糕<small>暖奶油 · 莓果紫</small></span>{theme === 'cream' && <Check size={14} />}
      </button>
    </div>}
  </div>;
}
