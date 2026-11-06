// Printable schedule (Schedules page → Print / PDF): one cutoff (the 1st–15th or the 16th–end) on
// A4 landscape, to post or hand out. People are grouped by position (like the page), one column per
// day (the day number and weekday; the month is in the heading), shift names in their colors, a
// count of people on shift per day, and a legend table (Shift | Time in | Time out, like the
// posted schedule's). The heading, column headings and footer (printed on, page x of y) repeat on every page.

import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import type { TFunction } from 'i18next';
import type { ScheduleEntry, ShiftType } from '../../services/attendanceService';
import { addDaysYmd, formatClock, offDutyLabel, shortClock, textOn, weekdayShort, weekdayOf } from './attendanceShared';

type Rgb = [number, number, number];

const rgbOf = (hex: string | null | undefined, fallback: Rgb = [229, 231, 235]): Rgb => {
  const m = String(hex ?? '').match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : fallback;
};
const textRgbOn = (hex: string | null | undefined): Rgb => (textOn(hex ?? '#E5E7EB') === '#FFFFFF' ? [255, 255, 255] : [17, 24, 39]);

// Colors (the same as the page).
const INDIGO: Rgb = [79, 70, 229];
// Weekend column headings: lighter, so Saturdays and Sundays stand out across the grid.
const INDIGO_WEEKEND: Rgb = [129, 140, 248];
const GROUP_FILL: Rgb = [245, 243, 255];
const GROUP_TEXT: Rgb = [91, 33, 182];
const WEEKEND_FILL: Rgb = [243, 244, 246];
const OFF_DUTY_FILL: Record<string, { fill: Rgb; text: Rgb }> = {
  day_off: { fill: [229, 231, 235], text: [55, 65, 81] },
  leave: { fill: [237, 233, 254], text: [91, 33, 182] },
  absent: { fill: [254, 226, 226], text: [153, 27, 27] },
};

const MARGIN = 28;
const CELL_PADDING = 2;
// Day cells: the largest text size, and the smallest a name may shrink to so it fits.
const DAY_FONT_MAX = 8;
const DAY_FONT_MIN = 5;

export interface SchedulePdfRow {
  name: string;
  position: string;
  /** Entry per date of the range, null = not scheduled. */
  entries: (ScheduleEntry | null)[];
}

const datesOf = (start: string, end: string) => {
  const out: string[] = [];
  for (let d = start; d <= end; d = addDaysYmd(d, 1)) out.push(d);
  return out;
};

/** "November 1 - 15, 2026" (a cutoff is always within one month). jsPDF's fonts have no en dash. */
const periodLabel = (start: string, end: string) => {
  const month = new Date(`${start}T00:00:00Z`).toLocaleDateString('en-US', { month: 'long', timeZone: 'UTC' });
  const sameMonth = start.slice(0, 7) === end.slice(0, 7);
  const endMonth = sameMonth ? '' : `${new Date(`${end}T00:00:00Z`).toLocaleDateString('en-US', { month: 'long', timeZone: 'UTC' })} `;
  return `${month} ${Number(start.slice(8))} - ${endMonth}${Number(end.slice(8))}, ${end.slice(0, 4)}`;
};

/** Builds the PDF (the page opens the print screen for it; it isn't downloaded). */
export function buildSchedulePdf({
  t,
  branchName,
  range,
  filterLabel,
  rows,
  shiftTypes,
}: {
  t: TFunction;
  branchName: string;
  range: { start: string; end: string };
  /** "All positions" or the positions chosen in the filter. */
  filterLabel: string;
  /** Already in display order (grouped by position). */
  rows: SchedulePdfRow[];
  shiftTypes: ShiftType[];
}): Blob {
  const doc = new jsPDF('l', 'pt', 'a4');
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const dates = datesOf(range.start, range.end);
  const isWeekend = (d: string) => weekdayOf(d) === 0 || weekdayOf(d) === 6;

  const cellText = (e: ScheduleEntry | null) => {
    if (!e) return '';
    if (e.type === 'shift') return e.name ?? `${shortClock(e.start)}-${shortClock(e.end)}`;
    return offDutyLabel(t, e.type);
  };

  // Column widths: No., employee name, then the days share the rest.
  const noWidth = 22;
  const nameWidth = dates.length > 7 ? 128 : 170;
  const dayWidth = (pageWidth - MARGIN * 2 - noWidth - nameWidth) / dates.length;

  // One text size for every day cell, the largest at which no word of any shift (or day off) name
  // has to be broken: a name may wrap at a space ("Whole / day") but never mid-word.
  doc.setFont('helvetica', 'bold');
  const room = dayWidth - CELL_PADDING * 2 - 1.5;
  const widthAt = (text: string, size: number) => (doc.getStringUnitWidth(text) * size) / doc.internal.scaleFactor;
  const labels = [...new Set(rows.flatMap((r) => r.entries.map(cellText)).filter(Boolean))];
  const fits = (parts: string[], size: number) => parts.every((p) => widthAt(p, size) <= room);
  const largestFitting = (parts: string[]) => {
    let size = DAY_FONT_MAX;
    while (size > DAY_FONT_MIN && !fits(parts, size)) size -= 0.25;
    return size;
  };
  // Whole names on one line when that stays readable, else words on separate lines.
  const oneLine = largestFitting(labels);
  const dayFont = oneLine >= 6.5 ? oneLine : largestFitting(labels.flatMap((l) => l.split(/\s+/)));

  // Body: a heading row per position, then its people.
  type Meta = { kind: 'group' } | { kind: 'person'; row: SchedulePdfRow };
  const meta: Meta[] = [];
  // (src/types/jspdf-autotable.d.ts leaves the library untyped, so the cell shape is spelled out.)
  const body: (string | { content: string; colSpan: number; styles: Record<string, unknown> })[][] = [];
  let lastPosition: string | null = null;
  rows.forEach((r, i) => {
    if (r.position !== lastPosition) {
      lastPosition = r.position;
      const count = rows.filter((x) => x.position === r.position).length;
      meta.push({ kind: 'group' });
      body.push([
        {
          content: `${(r.position || t('attendance.no_position', 'No position')).toUpperCase()}  (${count})`,
          colSpan: dates.length + 2,
          styles: { fillColor: GROUP_FILL, textColor: GROUP_TEXT, fontStyle: 'bold', halign: 'left', fontSize: 7.5, cellPadding: { top: 3, bottom: 3, left: 6, right: 6 } },
        },
      ]);
    }
    meta.push({ kind: 'person', row: r });
    body.push([String(i + 1), r.name, ...r.entries.map(cellText)]);
  });
  const onShift = dates.map((_, c) => rows.filter((r) => r.entries[c]?.type === 'shift').length);

  const printedAt = new Date().toLocaleString('en-US', {
    timeZone: 'Asia/Manila',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });

  const drawHeading = () => {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(15);
    doc.setTextColor(30, 30, 30);
    doc.text(`${branchName ? `${branchName} ` : ''}${t('attendance.schedule', 'Schedule')}`, MARGIN, 34);
    doc.setFontSize(11);
    doc.setTextColor(...INDIGO);
    doc.text(periodLabel(range.start, range.end), MARGIN, 50);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8.5);
    doc.setTextColor(110, 110, 110);
    doc.text(filterLabel, pageWidth - MARGIN, 50, { align: 'right' });
  };

  autoTable(doc, {
    startY: 62,
    theme: 'grid',
    margin: { top: 62, left: MARGIN, right: MARGIN, bottom: 36 },
    head: [
      [
        t('attendance.pdf_no', 'No.'),
        t('attendance.pdf_employee_name', 'Employee name'),
        // The day and weekday; the month is in the heading.
        ...dates.map((d) => `${Number(d.slice(8))}\n${weekdayShort(t, weekdayOf(d))}`),
      ],
    ],
    body,
    foot: [[{ content: t('attendance.on_shift_per_day', 'On shift'), colSpan: 2, styles: { halign: 'left' } }, ...onShift.map((n) => (n ? String(n) : '-'))]],
    showHead: 'everyPage',
    showFoot: 'lastPage',
    styles: {
      font: 'helvetica',
      fontSize: 8,
      cellPadding: CELL_PADDING,
      valign: 'middle',
      halign: 'center',
      overflow: 'linebreak',
      lineColor: [209, 213, 219],
      lineWidth: 0.5,
      minCellHeight: 18,
    },
    headStyles: { fillColor: INDIGO, textColor: [255, 255, 255], fontSize: 8, fontStyle: 'bold', minCellHeight: 24 },
    footStyles: { fillColor: [249, 250, 251], textColor: [55, 65, 81], fontStyle: 'bold', fontSize: 8, minCellHeight: 16 },
    columnStyles: {
      0: { cellWidth: noWidth, textColor: [107, 114, 128] },
      1: { cellWidth: nameWidth, halign: 'left', fontStyle: 'bold', cellPadding: { top: 2, bottom: 2, left: 5, right: 4 } },
      ...Object.fromEntries(dates.map((_, i) => [i + 2, { cellWidth: dayWidth }])),
    },
    didParseCell: (hook) => {
      const col = hook.column.index - 2;
      if (col < 0) return;
      const date = dates[col];
      if (hook.section === 'head') {
        if (isWeekend(date)) hook.cell.styles.fillColor = INDIGO_WEEKEND;
        return;
      }
      if (hook.section !== 'body') return;
      const m = meta[hook.row.index];
      if (!m || m.kind !== 'person') return;
      const entry = m.row.entries[col];
      hook.cell.styles.fontSize = dayFont;
      if (!entry) {
        if (isWeekend(date)) hook.cell.styles.fillColor = WEEKEND_FILL;
        return;
      }
      if (entry.type === 'shift') {
        hook.cell.styles.fillColor = rgbOf(entry.color);
        hook.cell.styles.textColor = textRgbOn(entry.color);
      } else {
        hook.cell.styles.fillColor = OFF_DUTY_FILL[entry.type].fill;
        hook.cell.styles.textColor = OFF_DUTY_FILL[entry.type].text;
      }
      hook.cell.styles.fontStyle = 'bold';
    },
    didDrawPage: drawHeading,
  });

  // Legend under the grid, like the posted schedule's: Shift | Time in | Time out, one row per
  // shift (in its color).
  const legendShifts = shiftTypes.filter((s) => s.active);
  const LEGEND_ROW = 17;
  const legendHeight = (legendShifts.length + 1) * LEGEND_ROW;
  let legendY = ((doc as unknown as { lastAutoTable?: { finalY: number } }).lastAutoTable?.finalY ?? 62) + 14;
  if (legendShifts.length && legendY + legendHeight > pageHeight - 36) {
    doc.addPage();
    drawHeading();
    legendY = 70;
  }
  type Hook = { section: string; row: { index: number }; column: { index: number }; cell: { styles: Record<string, unknown> } };
  const legendStyles = {
    theme: 'grid' as const,
    startY: legendY,
    pageBreak: 'avoid' as const,
    styles: { fontSize: 8.5, cellPadding: 3, halign: 'center', valign: 'middle', lineColor: [209, 213, 219], lineWidth: 0.5, textColor: [31, 41, 55], minCellHeight: LEGEND_ROW },
    headStyles: { fillColor: INDIGO, textColor: [255, 255, 255], fontStyle: 'bold' },
  };
  if (legendShifts.length) {
    autoTable(doc, {
      ...legendStyles,
      margin: { left: MARGIN },
      tableWidth: 290,
      head: [[t('attendance.shift', 'Shift'), t('attendance.time_in', 'Time in'), t('attendance.time_out', 'Time out')]],
      body: legendShifts.map((s) => [s.name, formatClock(s.start), formatClock(s.end)]),
      columnStyles: { 0: { cellWidth: 100 }, 1: { cellWidth: 95 }, 2: { cellWidth: 95 } },
      didParseCell: (hook: Hook) => {
        if (hook.section !== 'body') return;
        if (hook.column.index === 0) {
          const s = legendShifts[hook.row.index];
          hook.cell.styles.fillColor = rgbOf(s.color);
          hook.cell.styles.textColor = textRgbOn(s.color);
          hook.cell.styles.fontStyle = 'bold';
        }
        if (hook.column.index === 1 || hook.column.index === 2) hook.cell.styles.fontStyle = 'bold';
      },
    });
  }

  // Footer on every page: when it was printed, and the page number.
  const pages = doc.getNumberOfPages();
  for (let p = 1; p <= pages; p += 1) {
    doc.setPage(p);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.5);
    doc.setTextColor(140, 140, 140);
    doc.text(t('attendance.pdf_printed', { when: printedAt, defaultValue: `Printed ${printedAt}` }), MARGIN, pageHeight - 18);
    doc.text(
      t('attendance.pdf_page', { page: p, pages, defaultValue: `Page ${p} of ${pages}` }),
      pageWidth - MARGIN,
      pageHeight - 18,
      { align: 'right' },
    );
  }

  return doc.output('blob');
}
