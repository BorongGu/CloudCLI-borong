import { lazy, Suspense } from 'react';
import type { ComponentProps } from 'react';

const Sidebar = lazy(() => import('@/modules/code-editor/EditorSidebar'));
const Preview = lazy(() => import('@/modules/code-editor/markdown/MarkdownPreview'));

/** The editor barrel loads CodeMirror when a workspace opens the editor, keeping transcript rendering lightweight. */
export function EditorSidebarLoader(props: ComponentProps<typeof Sidebar>) {
  return <Suspense fallback={null}><Sidebar {...props} /></Suspense>;
}

/** The editor barrel loads the full preview only for preview consumers. */
export function MarkdownPreviewLoader(props: ComponentProps<typeof Preview>) {
  return <Suspense fallback={null}><Preview {...props} /></Suspense>;
}
