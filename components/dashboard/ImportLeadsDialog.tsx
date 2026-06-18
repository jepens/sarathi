'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Papa from 'papaparse';
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select';
import { toast } from 'sonner';
import { Loader2, Upload, Download, CheckCircle2, XCircle } from 'lucide-react';
import {
    leadInputSchema,
    fieldForHeader,
    LEAD_CSV_COLUMNS,
    type LeadFieldKey,
} from '@/lib/leads/schema';

// Human labels for the mappable target fields (the import dialog's column-map
// dropdowns). Kept local — the only consumer.
const FIELD_LABELS: Record<LeadFieldKey, string> = {
    contact_name: 'Nama',
    phone_number: 'Nomor HP',
    email: 'Email',
    event_interest: 'Jenis acara',
    participant_count: 'Jumlah pax',
    location_pref: 'Lokasi',
    event_date_pref: 'Tanggal',
    event_goals: 'Tujuan',
    budget_range: 'Budget',
    source: 'Sumber',
    lead_stage: 'Stage',
    assigned_to: 'PIC / Sales',
    notes: 'Catatan',
};

const FIELD_KEYS = Object.keys(FIELD_LABELS) as LeadFieldKey[];
const IGNORE = '__ignore__';
const PREVIEW_LIMIT = 12;

type ImportSummary = {
    total: number;
    created: number;
    updated: number;
    unchanged: number;
    skipped: number;
    conflicts: number;
    errorCount: number;
    errors: { index: number; message: string }[];
};

type CsvRow = Record<string, string>;

interface ImportLeadsDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onSuccess: () => void;
}

export function ImportLeadsDialog({ open, onOpenChange, onSuccess }: ImportLeadsDialogProps) {
    const [step, setStep] = useState<'upload' | 'preview' | 'done'>('upload');
    const [fileName, setFileName] = useState('');
    const [fields, setFields] = useState<string[]>([]);
    const [rows, setRows] = useState<CsvRow[]>([]);
    const [mapping, setMapping] = useState<Record<string, LeadFieldKey | ''>>({});
    const [importing, setImporting] = useState(false);
    const [summary, setSummary] = useState<ImportSummary | null>(null);
    const [clientInvalid, setClientInvalid] = useState(0);
    const fileInputRef = useRef<HTMLInputElement>(null);

    // Reset everything whenever the dialog (re)opens.
    useEffect(() => {
        setStep('upload');
        setFileName('');
        setFields([]);
        setRows([]);
        setMapping({});
        setImporting(false);
        setSummary(null);
        setClientInvalid(0);
    }, [open]);

    // Map each raw CSV row to a { fieldKey: value } object using the current
    // column mapping, dropping unmapped columns and blank cells.
    const mapped = useMemo(() => {
        return rows.map((row) => {
            const obj: Record<string, string> = {};
            for (const [header, field] of Object.entries(mapping)) {
                if (!field) continue;
                const value = row[header];
                if (value != null && String(value).trim() !== '') {
                    obj[field] = String(value);
                }
            }
            return obj;
        });
    }, [rows, mapping]);

    // Validate each mapped row against the shared schema (same one the server uses).
    const checks = useMemo(
        () =>
            mapped.map((m) => {
                const res = leadInputSchema.safeParse(m);
                return res.success
                    ? { ok: true as const, msg: '' }
                    : { ok: false as const, msg: res.error.issues[0]?.message ?? 'Tidak valid' };
            }),
        [mapped]
    );

    const validCount = checks.filter((c) => c.ok).length;
    const invalidCount = checks.length - validCount;

    function downloadTemplate() {
        const csv = Papa.unparse({
            fields: LEAD_CSV_COLUMNS.map((c) => c.header),
            data: [LEAD_CSV_COLUMNS.map((c) => c.example)],
        });
        const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'template-lead.csv';
        a.click();
        URL.revokeObjectURL(url);
    }

    function handleFile(file: File) {
        Papa.parse<CsvRow>(file, {
            header: true,
            skipEmptyLines: 'greedy',
            complete: (results) => {
                const detected = (results.meta.fields ?? []).filter((f) => f && f.trim() !== '');
                if (detected.length === 0) {
                    toast.error('File tidak punya baris header yang terbaca');
                    return;
                }
                const initial: Record<string, LeadFieldKey | ''> = {};
                for (const f of detected) initial[f] = fieldForHeader(f) ?? '';
                setFields(detected);
                setRows(results.data);
                setMapping(initial);
                setFileName(file.name);
                setStep('preview');
            },
            error: (err) => toast.error('Gagal membaca file: ' + err.message),
        });
    }

    async function handleImport() {
        const validRows = mapped.filter((_, i) => checks[i].ok);
        if (validRows.length === 0) {
            toast.error('Tidak ada baris valid untuk diimpor');
            return;
        }
        setImporting(true);
        try {
            const res = await fetch('/api/leads/import', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ rows: validRows }),
            });
            if (!res.ok) {
                const err = (await res.json().catch(() => ({}))) as { error?: string };
                throw new Error(err.error || 'Impor gagal');
            }
            const data = (await res.json()) as ImportSummary;
            setClientInvalid(invalidCount);
            setSummary(data);
            setStep('done');
            onSuccess();
        } catch (error) {
            toast.error(error instanceof Error ? error.message : 'Impor gagal');
        } finally {
            setImporting(false);
        }
    }

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-[760px] max-h-[90dvh] overflow-y-auto">
                <DialogHeader>
                    <DialogTitle>
                        Impor Lead dari CSV
                        {step === 'preview' && fileName ? ` — ${fileName}` : ''}
                    </DialogTitle>
                </DialogHeader>

                {step === 'upload' && (
                    <div className="space-y-4">
                        <p className="text-sm text-muted-foreground">
                            Unggah file CSV berisi lead dari sumber offline (pameran, walk-in,
                            referral, dll.). Belum punya formatnya? Unduh template di bawah, isi,
                            lalu unggah kembali.
                        </p>

                        <Button variant="outline" onClick={downloadTemplate} className="gap-2">
                            <Download className="h-4 w-4" />
                            Unduh template CSV
                        </Button>

                        <label
                            htmlFor="csv-file"
                            className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-input bg-muted/30 px-4 py-10 text-center transition-colors hover:bg-muted/50"
                        >
                            <Upload className="h-6 w-6 text-muted-foreground" />
                            <span className="text-sm font-medium">Pilih file CSV</span>
                            <span className="text-xs text-muted-foreground">
                                Kolom akan dicocokkan otomatis; bisa kamu sesuaikan setelahnya.
                            </span>
                            <input
                                ref={fileInputRef}
                                id="csv-file"
                                type="file"
                                accept=".csv,text/csv"
                                className="sr-only"
                                onChange={(e) => {
                                    const file = e.target.files?.[0];
                                    if (file) handleFile(file);
                                    // allow re-selecting the same file
                                    e.target.value = '';
                                }}
                            />
                        </label>
                    </div>
                )}

                {step === 'preview' && (
                    <div className="space-y-4">
                        <div className="rounded-md border bg-muted/30 p-3 text-sm">
                            <span className="font-medium">{rows.length}</span> baris terbaca ·{' '}
                            <span className="font-medium text-emerald-600 dark:text-emerald-400">
                                {validCount} valid
                            </span>
                            {invalidCount > 0 && (
                                <>
                                    {' '}·{' '}
                                    <span className="font-medium text-destructive">
                                        {invalidCount} bermasalah
                                    </span>
                                </>
                            )}
                        </div>

                        {/* Column mapping */}
                        <div>
                            <h4 className="mb-2 text-sm font-medium">Pencocokan kolom</h4>
                            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                                {fields.map((header) => (
                                    <div
                                        key={header}
                                        className="flex items-center gap-2 text-sm"
                                    >
                                        <span
                                            className="w-1/2 truncate text-muted-foreground"
                                            title={header}
                                        >
                                            {header}
                                        </span>
                                        <span className="text-muted-foreground">→</span>
                                        <Select
                                            value={mapping[header] === '' ? IGNORE : mapping[header]}
                                            onValueChange={(v) =>
                                                setMapping((m) => ({
                                                    ...m,
                                                    [header]: v === IGNORE ? '' : (v as LeadFieldKey),
                                                }))
                                            }
                                        >
                                            <SelectTrigger className="h-8 flex-1">
                                                <SelectValue />
                                            </SelectTrigger>
                                            <SelectContent>
                                                <SelectItem value={IGNORE}>
                                                    — abaikan —
                                                </SelectItem>
                                                {FIELD_KEYS.map((key) => (
                                                    <SelectItem key={key} value={key}>
                                                        {FIELD_LABELS[key]}
                                                    </SelectItem>
                                                ))}
                                            </SelectContent>
                                        </Select>
                                    </div>
                                ))}
                            </div>
                        </div>

                        {/* Preview table */}
                        <div>
                            <h4 className="mb-2 text-sm font-medium">
                                Pratinjau ({Math.min(rows.length, PREVIEW_LIMIT)} dari {rows.length})
                            </h4>
                            <div className="overflow-x-auto rounded-md border">
                                <table className="w-full text-xs">
                                    <thead className="bg-muted/50">
                                        <tr>
                                            <th className="px-2 py-1.5 text-left font-medium">
                                                Status
                                            </th>
                                            {fields.map((h) => (
                                                <th
                                                    key={h}
                                                    className="px-2 py-1.5 text-left font-medium whitespace-nowrap"
                                                >
                                                    {h}
                                                </th>
                                            ))}
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {rows.slice(0, PREVIEW_LIMIT).map((row, i) => (
                                            <tr key={i} className="border-t">
                                                <td className="px-2 py-1.5 align-top">
                                                    {checks[i]?.ok ? (
                                                        <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                                                    ) : (
                                                        <span
                                                            className="flex items-center gap-1 text-destructive"
                                                            title={checks[i]?.msg}
                                                        >
                                                            <XCircle className="h-4 w-4 shrink-0" />
                                                            <span className="hidden sm:inline">
                                                                {checks[i]?.msg}
                                                            </span>
                                                        </span>
                                                    )}
                                                </td>
                                                {fields.map((h) => (
                                                    <td
                                                        key={h}
                                                        className="max-w-[160px] truncate px-2 py-1.5 align-top"
                                                        title={row[h]}
                                                    >
                                                        {row[h]}
                                                    </td>
                                                ))}
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        </div>
                    </div>
                )}

                {step === 'done' && summary && (
                    <div className="space-y-3">
                        <div className="flex items-center gap-2 text-sm font-medium text-emerald-600 dark:text-emerald-400">
                            <CheckCircle2 className="h-5 w-5" />
                            Impor selesai
                        </div>
                        <ul className="space-y-1 text-sm">
                            <li>
                                Lead baru dibuat: <strong>{summary.created}</strong>
                            </li>
                            <li>
                                Lead diperbarui (data dilengkapi): <strong>{summary.updated}</strong>
                            </li>
                            <li>
                                Sudah lengkap, tidak berubah: <strong>{summary.unchanged}</strong>
                            </li>
                            {summary.conflicts > 0 && (
                                <li className="text-amber-600 dark:text-amber-400">
                                    Dilewati (nomor sudah jadi kontak lain):{' '}
                                    <strong>{summary.conflicts}</strong>
                                </li>
                            )}
                            {clientInvalid > 0 && (
                                <li className="text-muted-foreground">
                                    Tidak dikirim (baris bermasalah): <strong>{clientInvalid}</strong>
                                </li>
                            )}
                            {summary.errorCount > 0 && (
                                <li className="text-destructive">
                                    Gagal disimpan: <strong>{summary.errorCount}</strong>
                                </li>
                            )}
                        </ul>
                    </div>
                )}

                <DialogFooter>
                    {step === 'preview' && (
                        <>
                            <Button
                                type="button"
                                variant="outline"
                                onClick={() => setStep('upload')}
                                disabled={importing}
                            >
                                Ganti file
                            </Button>
                            <Button
                                type="button"
                                onClick={handleImport}
                                disabled={importing || validCount === 0}
                            >
                                {importing && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                                Impor {validCount} lead
                            </Button>
                        </>
                    )}
                    {step === 'done' && (
                        <Button type="button" onClick={() => onOpenChange(false)}>
                            Selesai
                        </Button>
                    )}
                    {step === 'upload' && (
                        <Button
                            type="button"
                            variant="outline"
                            onClick={() => onOpenChange(false)}
                        >
                            Batal
                        </Button>
                    )}
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
