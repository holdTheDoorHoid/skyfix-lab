/** A view asks the shell to bring the panel into view (polish2, list item 38). */
import { describe, expect, it } from 'vitest';
import { onRevealPanel, revealPanel } from '../../src/next/panel/reveal.js';

describe('revealPanel', () => {
  it('reaches the explorer’s own shell, with the rest asked for, until it stops listening', () => {
    const a = {};
    const b = {};
    const heard: string[] = [];
    const stop = onRevealPanel(a, (to) => heard.push(`a:${to}`));
    onRevealPanel(b, (to) => heard.push(`b:${to}`));
    revealPanel(a);
    revealPanel(a, 'full');
    revealPanel(b);
    stop();
    revealPanel(a);
    expect(heard).toEqual(['a:peek', 'a:full', 'b:peek']);
  });
});
