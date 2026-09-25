/**
 * Every chart's Save menu (charts2 agent, expansion programme Q5). OWNER: charts2 agent.
 *
 *   Save ▾   Save picture (PNG)   the chart with a caption strip, in light colours
 *            Save table (CSV)     the Table view, for a spreadsheet
 *            Print                this chart alone, on one page
 *            Share picture…       the device's share sheet (where it has one)
 *
 * A chart gives the menu what to save (`ChartExportSpec`); the words of the caption and the
 * file's header lines come from the card itself (title, subtitle, the caption's sentences)
 * plus the chart's own labels ("Clear-sky estimate; clouds not modelled", "Predicted, not
 * observed"). Nothing is sent anywhere: files are made in the page and handed to the
 * browser's download, the printer or the device's share sheet.
 */

import { h } from '../../dom.js';
import { fileName, saveBlob, saveText, tablesToCsv } from '../export/csv.js';
import { canShareFiles, PICTURE_FOOTER, shareFile, svgToPng } from '../export/png.js';
import { button, popover, type Popover } from '../theme/primitives.js';
import { captionSentences, cardWords, errorText, type Card } from './frame.js';
import { printCard, wantsLandscape } from './print.js';

export interface ChartExportSpec {
  /** File name parts after `skyfix`: `['sun-path', '2026-09-24']`. */
  fileParts(): (string | number)[];
  /** The picture: the chart's own SVG as drawn, or one made for saving; null while there is none. */
  picture(): SVGSVGElement | null;
  /** The Table view's tables, drawn now if they are not yet. */
  tables(): HTMLTableElement[];
  /** Lines every copy must carry beside the numbers: what they are, how far to trust them. */
  labels?(): string[];
}

type Action = 'png' | 'csv' | 'print' | 'share';

const SVG_NS = 'http://www.w3.org/2000/svg';

/** The Save button's icon: an arrow into a tray, in the design system's icon style. */
function saveIcon(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  for (const [k, v] of [
    ['viewBox', '0 0 24 24'],
    ['fill', 'none'],
    ['stroke', 'currentColor'],
    ['stroke-width', '1.75'],
    ['stroke-linecap', 'round'],
    ['stroke-linejoin', 'round'],
    ['class', 'sf-icon'],
    ['aria-hidden', 'true'],
    ['focusable', 'false'],
  ]) {
    svg.setAttribute(k!, v!);
  }
  for (const d of ['M12 4v10.5', 'M7.5 10 12 14.5 16.5 10', 'M4.5 15.5v3.2c0 .7.6 1.3 1.3 1.3h12.4c.7 0 1.3-.6 1.3-1.3v-3.2']) {
    const p = document.createElementNS(SVG_NS, 'path');
    p.setAttribute('d', d);
    svg.append(p);
  }
  return svg;
}

/** The header lines of a CSV file: what it is, where and when, the labels, where it came from. */
export function csvComments(title: string, subtitle: string, sentences: string, labels: readonly string[]): string[] {
  return [`SkyFix Lab: ${title}`, subtitle, sentences, ...labels, PICTURE_FOOTER].filter((l) => l.trim() !== '');
}

/**
 * Put the Save menu in the card's header. Returns the clean-up function (the menu's
 * popover lives on `<body>`).
 */
export function attachExport(c: Card, spec: ChartExportSpec): () => void {
  const status = (text: string): void => {
    c.status.textContent = text;
  };
  const trigger = button({
    label: 'Save',
    iconAfter: 'chevron-down',
    size: 'sm',
    variant: 'secondary',
    class: 'sfc-save',
    tip: 'Save this chart as a picture or a table, print it or share it',
  });
  trigger.prepend(saveIcon());

  const items: { action: Action; label: string; hint: string }[] = [
    { action: 'png', label: 'Save picture (PNG)', hint: 'The chart with its caption, in light colours' },
    { action: 'csv', label: 'Save table (CSV)', hint: 'The Table view’s numbers, for a spreadsheet' },
    { action: 'print', label: 'Print', hint: 'This chart alone, on one page' },
  ];
  if (canShareFiles()) items.push({ action: 'share', label: 'Share picture…', hint: 'With this device’s share sheet' });

  const list = h('div', { class: 'sf-menu sfc-export-menu', role: 'menu', 'aria-label': 'Save, print or share this chart' });
  const buttons = items.map((item) =>
    h(
      'button',
      { type: 'button', class: 'sf-menu__item', role: 'menuitem', tabindex: '-1', 'data-action': item.action },
      h('span', {}, item.label),
      h('span', { class: 'sf-menu__hint' }, item.hint),
    ),
  );
  list.append(...buttons);
  list.addEventListener('keydown', (event) => {
    const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (i < 0) return;
    const j =
      event.key === 'ArrowDown'
        ? (i + 1) % buttons.length
        : event.key === 'ArrowUp'
          ? (i - 1 + buttons.length) % buttons.length
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? buttons.length - 1
              : -1;
    if (j < 0) return;
    event.preventDefault();
    buttons[j]!.focus();
  });

  let pop: Popover | null = popover(trigger, list, {
    label: 'Save, print or share this chart',
    role: 'menu',
    onStage: true,
    placement: 'bottom-end',
    onOpen: () => {
      buttons.forEach((b, k) => (b.tabIndex = k === 0 ? 0 : -1));
    },
  });
  c.actions.append(trigger);

  const picture = async (): Promise<{ blob: Blob; name: string; title: string } | null> => {
    const svg = spec.picture();
    if (!svg) {
      status('There is no chart to save yet.');
      return null;
    }
    const { title, subtitle } = cardWords(c);
    const lines = [subtitle, captionSentences(c), ...(spec.labels?.() ?? [])].filter((l) => l.trim() !== '');
    const blob = await svgToPng(svg, { title, lines });
    return { blob, name: fileName(spec.fileParts(), 'png'), title };
  };

  const run = async (action: Action): Promise<void> => {
    try {
      if (action === 'csv') {
        const tables = spec.tables();
        if (!tables.length) {
          status('There is no table to save yet.');
          return;
        }
        const { title, subtitle } = cardWords(c);
        const name = fileName(spec.fileParts(), 'csv');
        saveText(tablesToCsv(tables, csvComments(title, subtitle, captionSentences(c), spec.labels?.() ?? [])), name);
        status(`Saved ${name}.`);
      } else if (action === 'png') {
        status('Making the picture…');
        const made = await picture();
        if (!made) return;
        saveBlob(made.blob, made.name);
        status(`Saved ${made.name}.`);
      } else if (action === 'share') {
        status('Making the picture…');
        const made = await picture();
        if (!made) return;
        const result = await shareFile(made.blob, made.name, made.title);
        status(result === 'shared' ? 'Shared.' : result === 'cancelled' ? '' : 'This device cannot share pictures: save it instead.');
      } else {
        const svg = spec.picture();
        const w = Number(svg?.getAttribute('width')) || 0;
        const hgt = Number(svg?.getAttribute('height')) || 0;
        status('');
        printCard(c.root, { landscape: !c.figure.hidden && wantsLandscape(w, hgt), title: `SkyFix Lab · ${cardWords(c).title}` });
      }
    } catch (error) {
      status(`Could not ${action === 'csv' ? 'save the table' : action === 'print' ? 'print' : 'make the picture'}: ${errorText(error)}`);
    }
  };

  for (const b of buttons) {
    b.addEventListener('click', () => {
      const action = b.getAttribute('data-action') as Action;
      pop?.close();
      void run(action);
    });
  }

  return () => {
    pop?.destroy();
    pop = null;
    trigger.remove();
  };
}
