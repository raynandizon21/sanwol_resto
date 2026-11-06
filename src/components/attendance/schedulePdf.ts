// Printable schedule (Schedules page → Print / PDF), laid out like Sanwol's posted FOH schedule:
// No. | Employee name | Position | one column per date, shift names in their colors, and a legend
// of the shifts with their times in and out. A week fits A4 landscape; a month uses A3.

import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import type { TFunction } from 'i18next';
import type { ScheduleEntry, ShiftType } from '../../services/attendanceService';
import { formatClock, offDutyLabel, shortClock, textOn, weekdayShort, weekdayOf } from './attendanceShared';

type Rgb = [number, number, number];

const rgbOf = (hex: string | null | undefined, fallback: Rgb = [229, 231, 235]): Rgb => {
  const m = String(hex ?? '').match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : fallback;
};

// Off-duty cells (same colors as the page).
const OFF_DUTY_FILL: Record<string, { fill: Rgb; text: Rgb }> = {
  day_off: { fill: [229, 231, 235], text: [55, 65, 81] },
  leave: { fill: [237, 233, 254], text: [91, 33, 182] },
  absent: { fill: [254, 226, 226], text: [153, 27, 27] },
};

export interface SchedulePdfRow {
  name: string;
  position: string;
  /** Entry per date (same order as `dates`), null = not scheduled. */
  entries: (ScheduleEntry | null)[];
}

export function exportSchedulePdf({
  t,
  title,
  subtitle,
  dates,
  holidays,
  rows,
  shiftTypes,
  filename,
}: {
  t: TFunction;
  title: string;
  subtitle: string;
  dates: string[];
  holidays: Map<string, string>;
  rows: SchedulePdfRow[];
  shiftTypes: ShiftType[];
  filename: string;
}) {
  const doc = new jsPDF('l', 'pt', dates.length > 10 ? 'a3' : 'a4');
  const pageWidth = doc.internal.pageSize.getWidth();
  const margin = 30;

  doc.setFontSize(15);
  doc.setTextColor(30, 30, 30);
  doc.text(title, pageWidth / 2, 34, { align: 'center' });
  doc.setFontSize(9);
  doc.setTextColor(110, 110, 110);
  doc.text(subtitle, pageWidth / 2, 48, { align: 'center' });

  const cellText = (e: ScheduleEntry | null) => {
    if (!e) return '';
    if (e.type === 'shift') return (e.name ?? `${shortClock(e.start)}-${shortClock(e.end)}`).toUpperCase();
    return offDutyLabel(t, e.type).toUpperCase();
  };

  const month = dates.length > 10;
  const nameWidth = month ? 120 : 150;
  const positionWidth = month ? 90 : 130;
  const dayWidth = (pageWidth - margin * 2 - 24 - nameWidth - positionWidth) / dates.length;

  autoTable(doc, {
    startY: 60,
    theme: 'grid',
    margin: { left: margin, right: margin },
    head: [
      [
        t('attendance.pdf_no', 'No.'),
        t('attendance.pdf_employee_name', 'Employee name'),
        t('attendance.position', 'Position'),
        ...dates.map((d) => `${d.slice(5, 7)}/${d.slice(8)}\n${weekdayShort(t, weekdayOf(d))}`),
      ],
    ],
    body: rows.map((r, i) => [String(i + 1), r.name, r.position, ...r.entries.map(cellText)]),
    styles: { fontSize: month ? 6 : 7.5, cellPadding: 3, valign: 'middle', halign: 'center', overflow: 'linebreak' },
    headStyles: { fillColor: [79, 70, 229], textColor: [255, 255, 255], fontSize: month ? 6.5 : 8, fontStyle: 'bold' },
    columnStyles: {
      0: { cellWidth: 24 },
      1: { cellWidth: nameWidth, halign: 'left', fontStyle: 'bold' },
      2: { cellWidth: positionWidth, halign: 'left' },
      ...Object.fromEntries(dates.map((_, i) => [i + 3, { cellWidth: dayWidth }])),
    },
    didParseCell: (hook) => {
      const col = hook.column.index - 3;
      if (col < 0) return;
      // Holiday columns get a light blue heading.
      if (hook.section === 'head' && holidays.has(dates[col])) hook.cell.styles.fillColor = [3, 105, 161];
      if (hook.section !== 'body') return;
      const entry = rows[hook.row.index]?.entries[col];
      if (!entry) return;
      if (entry.type === 'shift') {
        const fill = rgbOf(entry.color);
        hook.cell.styles.fillColor = fill;
        hook.cell.styles.textColor = textOn(entry.color) === '#FFFFFF' ? [255, 255, 255] : [17, 24, 39];
      } else {
        hook.cell.styles.fillColor = OFF_DUTY_FILL[entry.type].fill;
        hook.cell.styles.textColor = OFF_DUTY_FILL[entry.type].text;
      }
      hook.cell.styles.fontStyle = 'bold';
    },
  });

  // Legend: the shifts with their times (like the posted schedule), then off-duty and holidays.
  const lastY = (doc as unknown as { lastAutoTable?: { finalY: number } }).lastAutoTable?.finalY ?? 60;
  const active = shiftTypes.filter((s) => s.active);
  autoTable(doc, {
    startY: lastY + 18,
    theme: 'grid',
    margin: { left: margin },
    tableWidth: 300,
    head: [[t('attendance.shift', 'Shift'), t('attendance.time_in', 'Time in'), t('attendance.time_out', 'Time out')]],
    body: active.map((s) => [s.name, formatClock(s.start), formatClock(s.end)]),
    styles: { fontSize: 8, cellPadding: 4, halign: 'center' },
    headStyles: { fillColor: [79, 70, 229], textColor: [255, 255, 255], fontStyle: 'bold' },
    didParseCell: (hook) => {
      if (hook.section !== 'body' || hook.column.index !== 0) return;
      const s = active[hook.row.index];
      hook.cell.styles.fillColor = rgbOf(s.color);
      hook.cell.styles.textColor = textOn(s.color) === '#FFFFFF' ? [255, 255, 255] : [17, 24, 39];
      hook.cell.styles.fontStyle = 'bold';
    },
  });
  const holidayList = dates.filter((d) => holidays.has(d)).map((d) => `${d.slice(5, 7)}/${d.slice(8)} ${holidays.get(d)}`);
  if (holidayList.length) {
    const y = ((doc as unknown as { lastAutoTable?: { finalY: number } }).lastAutoTable?.finalY ?? lastY) + 16;
    doc.setFontSize(8);
    doc.setTextColor(60, 60, 60);
    doc.text(`${t('attendance.rules_holidays', 'Holidays')}: ${holidayList.join(' · ')}`, margin, y);
  }

  doc.save(filename);
}
