import { lazy, Suspense } from 'react';
import type { ComponentProps } from 'react';

const Component = lazy(() => import('@/modules/chat/ChatInterface'));

/** The module barrel keeps the full ChatInterface workspace separate from shared rendering imports. */
export default function ChatInterfaceLoader(props: ComponentProps<typeof Component>) {
  return <Suspense fallback={null}><Component {...props} /></Suspense>;
}
