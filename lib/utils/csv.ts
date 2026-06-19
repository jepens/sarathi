import Papa from 'papaparse';

// Build a CSV from an array of flat objects (keys become the header row) and
// trigger a browser download. Prefixes a UTF-8 BOM so Excel opens Indonesian
// text correctly. Client-side only (uses Blob / document).
export function downloadCsv(filename: string, rows: Record<string, unknown>[]): void {
    const csv = Papa.unparse(rows);
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
}

/** "leads-2026-06-19" style date stamp for export filenames. */
export function csvDateStamp(): string {
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
