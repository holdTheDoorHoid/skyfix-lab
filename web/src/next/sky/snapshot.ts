/**
 * Save the sky as a PNG picture with a caption strip: what it shows, the place, the time,
 * and the site's line. OWNER: sky2 agent (expansion Q3).
 *
 * The picture is the Sky view's own canvas as last drawn — its layers, its size, and its
 * theme (the night theme stays red: this picture is of what is on screen, unlike a chart's,
 * which is always light) — with the caption the charts use below it (export/png.ts:
 * `layoutCaption`, `CAPTION_TYPE`, `PICTURE_FOOTER`), in the stage's colours. Nothing is
 * sent anywhere: the browser saves the file, or the device's share sheet takes it. The
 * place in the caption is the one on screen, and only because the person asked for it.
 */

import { captionHeight, CAPTION_TYPE, layoutCaption, PICTURE_FOOTER, type CaptionLine } from '../export/png.js';
import type { SkyPalette } from './palette.js';
import { css } from './palette.js';

export interface SnapshotCaption {
  /** "The sky from Philadelphia City Hall". */
  title: string;
  /** The time with UTC (and its ±ΔT when it applies), what the view shows, the sky's limit. */
  lines: string[];
}

const PAD = 16;

/**
 * A new canvas: the sky (`source`, device pixels at `dpr`) with the caption under it, in
 * `palette`'s stage colours.
 */
export function composeSnapshot(
  source: CanvasImageSource & { width: number; height: number },
  dpr: number,
  caption: SnapshotCaption,
  palette: Pick<SkyPalette, 'stageBg' | 'stageInk' | 'stageInk2' | 'stageInk3' | 'stageLine' | 'fontUi'>,
  make: (w: number, h: number) => HTMLCanvasElement = defaultCanvas,
): HTMLCanvasElement {
  const cssW = source.width / dpr;
  const probe = make(1, 1).getContext('2d');
  const font = (role: CaptionLine['role']): string => `${CAPTION_TYPE[role].weight} ${CAPTION_TYPE[role].size}px ${palette.fontUi}`;
  const measure = (text: string, role: CaptionLine['role']): number => {
    if (!probe) return text.length * CAPTION_TYPE[role].size * 0.55;
    probe.font = font(role);
    return probe.measureText(text).width;
  };
  const lines = layoutCaption({ title: caption.title, lines: caption.lines, footer: PICTURE_FOOTER }, cssW - 2 * PAD, measure);
  const stripCss = captionHeight(lines) + 2 * PAD - 6;
  const out = make(source.width, source.height + Math.round(stripCss * dpr));
  const g = out.getContext('2d');
  if (!g) throw new Error('This browser gave no canvas to draw the picture on.');
  g.drawImage(source, 0, 0);
  g.setTransform(dpr, 0, 0, dpr, 0, source.height);
  g.fillStyle = css(palette.stageBg);
  g.fillRect(0, 0, cssW, stripCss);
  g.fillStyle = css(palette.stageLine);
  g.fillRect(0, 0, cssW, 1);
  g.textAlign = 'left';
  g.textBaseline = 'alphabetic';
  const colour = { title: palette.stageInk, line: palette.stageInk2, footer: palette.stageInk3 } as const;
  let y = PAD - 4;
  lines.forEach((l, i) => {
    if (l.role === 'footer' && i > 0 && lines[i - 1]!.role !== 'footer') y += 6;
    const t = CAPTION_TYPE[l.role];
    y += t.lineHeight;
    g.font = font(l.role);
    g.fillStyle = css(colour[l.role]);
    g.fillText(l.text, PAD, y - (t.lineHeight - t.size) / 2);
  });
  return out;
}

function defaultCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

/** The picture as a PNG blob. */
export function canvasBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('The browser could not make the picture.'))), 'image/png');
  });
}
