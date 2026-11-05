import { lazy, Suspense } from 'react';
import type { ComponentProps } from 'react';

const Component = lazy(() => import('@/modules/command-palette/CommandPalette'));

/** The module barrel keeps the full CommandPalette workspace separate from shared rendering imports. */
export default function CommandPaletteLoader(props: ComponentProps<typeof Component>) {
  return <Suspense fallback={null}><Component {...props} /></Suspense>;
}
