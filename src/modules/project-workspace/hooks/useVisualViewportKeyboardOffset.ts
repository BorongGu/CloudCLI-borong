import { useEffect } from 'react';

/** Browser chrome and rounding can change the viewport by a few pixels without opening a keyboard. */
const MIN_KEYBOARD_OCCLUSION_PX = 120;

/** ProjectWorkspaceRoute keeps its fixed shell above the keyboard while retaining a stable reading viewport. */
export function useVisualViewportKeyboardOffset() {
  useEffect(() => {
    const visualViewport = window.visualViewport;
    if (!visualViewport) {
      return undefined;
    }

    // Coalesce viewport/focus events into one layout update, using their latest measurements.
    let frame = 0;
    let previousHeight: number | null = null;
    const updateKeyboardHeight = () => {
      frame = 0;
      const focused = document.activeElement;
      const acceptsText = focused instanceof HTMLElement && (
        focused.isContentEditable
        || focused instanceof HTMLTextAreaElement
        || (focused instanceof HTMLInputElement
          && /^(text|search|email|url|password|tel|number)$/.test(focused.type))
      );
      const occlusion = Math.round(Math.max(0, window.innerHeight - visualViewport.height));
      const keyboardHeight = acceptsText && Math.abs(visualViewport.scale - 1) < 0.01
        && occlusion >= MIN_KEYBOARD_OCCLUSION_PX ? occlusion : 0;
      if (keyboardHeight === previousHeight) return;
      previousHeight = keyboardHeight;
      document.documentElement.style.setProperty('--keyboard-height', `${keyboardHeight}px`);
    };

    const scheduleUpdate = () => { if (!frame) frame = requestAnimationFrame(updateKeyboardHeight); };
    scheduleUpdate();
    visualViewport.addEventListener('resize', scheduleUpdate);
    document.addEventListener('focusin', scheduleUpdate);
    document.addEventListener('focusout', scheduleUpdate);
    return () => {
      cancelAnimationFrame(frame);
      visualViewport.removeEventListener('resize', scheduleUpdate);
      document.removeEventListener('focusin', scheduleUpdate);
      document.removeEventListener('focusout', scheduleUpdate);
      document.documentElement.style.removeProperty('--keyboard-height');
    };
  }, []);
}
