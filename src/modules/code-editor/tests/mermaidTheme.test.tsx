import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

import MermaidDiagram from '@/modules/code-editor/markdown/MermaidDiagram';

const initialize = vi.hoisted(() => vi.fn());
vi.mock('mermaid', () => ({ default: { initialize, render: vi.fn(async () => ({ svg: '<svg />' })) } }));

afterEach(() => { cleanup();document.documentElement.classList.remove('dark'); });

test('standalone guest diagrams follow document theme changes while keeping the same component', async () => {
  document.documentElement.classList.add('dark');render(<MermaidDiagram code="graph TD; A-->B" />);
  await waitFor(() => expect(initialize).toHaveBeenLastCalledWith(expect.objectContaining({ theme: 'dark' })));
  document.documentElement.classList.remove('dark');
  await waitFor(() => expect(initialize).toHaveBeenLastCalledWith(expect.objectContaining({ theme: 'default' })));
});
