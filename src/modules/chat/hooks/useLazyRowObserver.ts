import { useCallback, useEffect, useMemo, useRef } from 'react';
import type { RefObject } from 'react';
import { flushSync } from 'react-dom';

import type { LazyRowObserver } from '@/shared/types';
import { captureChatScrollAnchor, restoreChatScrollAnchor } from '@/shared/utils';

/** How far beyond the viewport a transcript row keeps (or gains) its mounted content. */
const LAZY_ROW_VIEWPORT_MARGIN_PX = 1200;

/**
 * Used by ChatMessagesPane to share one IntersectionObserver across its LazyMessageRows,
 * rooted at its scroll container. Returns null where IntersectionObserver does
 * not exist (jsdom), which keeps every row permanently mounted — the
 * pre-existing behavior.
 */
export function useLazyRowObserver(
  scrollContainerRef: RefObject<HTMLDivElement>,
): LazyRowObserver | null {
  // One observer and callback registry keep the mounted band bounded for long transcripts.
  const observerRef = useRef<IntersectionObserver | null>(null);
  // Row subscriptions are kept stable as messages enter and leave the mounted band.
  const callbacksRef = useRef(new Map<Element, (isNearViewport: boolean) => void>());
  const isSupported = typeof IntersectionObserver !== 'undefined';

  useEffect(() => () => {
    observerRef.current?.disconnect();
    observerRef.current = null;
  }, []);

  const observe = useCallback<LazyRowObserver['observe']>((element, onNearViewportChange) => {
    if (!observerRef.current) {
      observerRef.current = new IntersectionObserver((observerEntries) => {
        const container = scrollContainerRef.current;
        const previousAnchoring = container?.style.overflowAnchor ?? '';
        // One owner adjusts this synchronous layout change. Native anchoring stays
        // available between transactions for images, fonts and other delayed content.
        if (container) container.style.overflowAnchor = 'none';
        try {
          const anchor = container ? captureChatScrollAnchor(container) : null;
          const wasAtBottom = container
            ? container.scrollHeight - container.clientHeight - container.scrollTop <= 1
            : false;
          flushSync(() => {
            for (const entry of observerEntries) {
              // A zero-sized rect belongs to a hidden tab: retain its row state and measured height.
              if (
                !entry.isIntersecting
                && entry.boundingClientRect.width === 0
                && entry.boundingClientRect.height === 0
              ) {
                continue;
              }
              callbacksRef.current.get(entry.target)?.(entry.isIntersecting);
            }
          });
          // A concurrent session switch can replace the captured transcript during the commit.
          if (container && anchor?.anchor?.isConnected) {
            const clampedAtBottom = wasAtBottom
              && container.scrollHeight - container.clientHeight - container.scrollTop <= 1;
            if (!clampedAtBottom) restoreChatScrollAnchor(container, anchor, true);
          }
        } finally {
          if (container) container.style.overflowAnchor = previousAnchoring;
        }
      }, {
        root: scrollContainerRef.current,
        rootMargin: `${LAZY_ROW_VIEWPORT_MARGIN_PX}px 0px`,
      });
    }

    callbacksRef.current.set(element, onNearViewportChange);
    observerRef.current.observe(element);
    return () => {
      callbacksRef.current.delete(element);
      observerRef.current?.unobserve(element);
    };
  }, [scrollContainerRef]);

  // Identity-stable so each row's observe effect runs once, not per render.
  return useMemo(() => (isSupported ? { observe } : null), [isSupported, observe]);
}
