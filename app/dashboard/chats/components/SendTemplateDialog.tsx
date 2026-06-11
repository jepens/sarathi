'use client';

import { useEffect, useMemo, useState } from 'react';
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DialogFooter,
    DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select';
import { Loader2, FileText, AlertCircle } from 'lucide-react';
import { toast } from 'sonner';

interface TemplateComponent {
    type: 'HEADER' | 'BODY' | 'FOOTER' | 'BUTTONS';
    text?: string;
    format?: string;
}

interface Template {
    id: string;
    name: string;
    language: string;
    category: string;
    status: string;
    components: TemplateComponent[];
}

interface SendTemplateDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    phoneNumber: string;
    onSent: () => void;
}

// Positional placeholder syntax {{1}}, {{2}}, ... in Meta templates.
const VAR_REGEX = /\{\{\s*(\d+)\s*\}\}/g;

function extractBodyVariableIndices(t: Template): number[] {
    const body = t.components.find((c) => c.type === 'BODY');
    if (!body?.text) return [];
    const set = new Set<number>();
    let m: RegExpExecArray | null;
    VAR_REGEX.lastIndex = 0;
    while ((m = VAR_REGEX.exec(body.text)) !== null) {
        const n = parseInt(m[1], 10);
        if (!Number.isNaN(n)) set.add(n);
    }
    return Array.from(set).sort((a, b) => a - b);
}

function renderBody(t: Template, vars: string[]): string {
    const body = t.components.find((c) => c.type === 'BODY');
    if (!body?.text) return '';
    return body.text.replace(VAR_REGEX, (_full, idxStr: string) => {
        const idx = parseInt(idxStr, 10);
        const value = vars[idx - 1];
        return typeof value === 'string' && value.length > 0
            ? value
            : `{{${idxStr}}}`;
    });
}

export function SendTemplateDialog({
    open,
    onOpenChange,
    phoneNumber,
    onSent,
}: SendTemplateDialogProps) {
    const [templates, setTemplates] = useState<Template[]>([]);
    const [selectedKey, setSelectedKey] = useState<string>('');
    const [variables, setVariables] = useState<string[]>([]);
    const [loadingList, setLoadingList] = useState(false);
    const [listError, setListError] = useState<string | null>(null);
    const [sending, setSending] = useState(false);

    // Fetch templates each time the dialog opens — admin might have just
    // had a new one approved by Meta.
    useEffect(() => {
        if (!open) return;
        let cancelled = false;
        setLoadingList(true);
        setListError(null);
        (async () => {
            try {
                const res = await fetch('/api/chat/templates');
                if (!res.ok) {
                    const j = (await res.json().catch(() => ({}))) as { error?: string };
                    throw new Error(j.error || `HTTP ${res.status}`);
                }
                const j = (await res.json()) as { templates: Template[] };
                if (!cancelled) {
                    setTemplates(j.templates ?? []);
                    if ((j.templates ?? []).length > 0) {
                        const first = j.templates[0];
                        setSelectedKey(`${first.name}|${first.language}`);
                    }
                }
            } catch (err) {
                if (!cancelled) {
                    setListError(err instanceof Error ? err.message : 'Failed to load templates');
                }
            } finally {
                if (!cancelled) setLoadingList(false);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [open]);

    const selected = useMemo(
        () =>
            templates.find(
                (t) => `${t.name}|${t.language}` === selectedKey
            ) || null,
        [templates, selectedKey]
    );

    const varIndices = useMemo(
        () => (selected ? extractBodyVariableIndices(selected) : []),
        [selected]
    );

    // Reset variable inputs whenever selected template changes. varIndices
    // is recomputed each render so we key off its length (stable for the
    // selected template) rather than the array identity to avoid a reset
    // loop.
    useEffect(() => {
        setVariables(varIndices.map(() => ''));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [selectedKey, varIndices.length]);

    const bodyText = selected?.components.find((c) => c.type === 'BODY')?.text ?? '';
    const headerText = selected?.components.find((c) => c.type === 'HEADER' && c.format === 'TEXT')?.text;
    const footerText = selected?.components.find((c) => c.type === 'FOOTER')?.text;

    const allFilled = varIndices.every(
        (_, i) => typeof variables[i] === 'string' && variables[i].trim().length > 0
    );

    const handleSend = async () => {
        if (!selected) return;
        if (!allFilled) {
            toast.error('Mohon isi semua variabel template');
            return;
        }
        setSending(true);
        const promise = (async () => {
            const res = await fetch('/api/chat/send-template', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    phone_number: phoneNumber,
                    template_name: selected.name,
                    language: selected.language,
                    variables: variables.map((v) => v.trim()),
                }),
            });
            if (!res.ok) {
                const j = (await res.json().catch(() => ({}))) as { error?: string };
                throw new Error(j.error || `Failed (HTTP ${res.status})`);
            }
        })();
        toast.promise(promise, {
            loading: 'Mengirim template…',
            success: 'Template message terkirim',
            error: (e) => (e instanceof Error ? e.message : 'Gagal mengirim template'),
        });
        try {
            await promise;
            onSent();
            onOpenChange(false);
        } catch (err) {
            console.error('send-template error:', err);
        } finally {
            setSending(false);
        }
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-[560px]">
                <DialogHeader>
                    <DialogTitle className="flex items-center gap-2">
                        <FileText className="h-5 w-5" />
                        Kirim Template Message
                    </DialogTitle>
                    <DialogDescription>
                        Untuk re-engage customer yang sudah lewat 24 jam sejak pesan terakhir. Hanya template yang sudah <strong>APPROVED</strong> di Meta yang bisa dipakai.
                    </DialogDescription>
                </DialogHeader>

                {loadingList ? (
                    <div className="flex items-center justify-center py-10">
                        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                    </div>
                ) : listError ? (
                    <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800">
                        <div className="flex items-start gap-2">
                            <AlertCircle className="h-4 w-4 mt-0.5 flex-shrink-0" />
                            <div>
                                <div className="font-medium">Gagal memuat template</div>
                                <div className="text-xs opacity-90">{listError}</div>
                                <div className="mt-2 text-xs opacity-80">
                                    Pastikan <code>WHATSAPP_BUSINESS_ACCOUNT_ID</code> sudah di-set di <code>.env.local</code> dan access token punya scope <code>whatsapp_business_management</code>.
                                </div>
                            </div>
                        </div>
                    </div>
                ) : templates.length === 0 ? (
                    <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
                        Belum ada template APPROVED. Buat dulu di{' '}
                        <a
                            href="https://business.facebook.com/wa/manage/message-templates/"
                            target="_blank"
                            rel="noopener noreferrer"
                            className="underline font-medium"
                        >
                            Meta Business Manager
                        </a>{' '}
                        dan tunggu approval.
                    </div>
                ) : (
                    <div className="space-y-4">
                        <div className="space-y-2">
                            <Label htmlFor="template-select">Template</Label>
                            <Select value={selectedKey} onValueChange={setSelectedKey}>
                                <SelectTrigger id="template-select">
                                    <SelectValue placeholder="Pilih template" />
                                </SelectTrigger>
                                <SelectContent>
                                    {templates.map((t) => (
                                        <SelectItem key={`${t.name}|${t.language}`} value={`${t.name}|${t.language}`}>
                                            {t.name} <span className="text-xs text-muted-foreground">({t.language} · {t.category})</span>
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </div>

                        {selected && (
                            <>
                                {varIndices.length > 0 && (
                                    <div className="space-y-3">
                                        <Label>Variabel</Label>
                                        {varIndices.map((idx, i) => (
                                            <div key={idx} className="space-y-1">
                                                <Label htmlFor={`var-${idx}`} className="text-xs text-muted-foreground">
                                                    {`{{${idx}}}`}
                                                </Label>
                                                <Input
                                                    id={`var-${idx}`}
                                                    value={variables[i] ?? ''}
                                                    onChange={(e) => {
                                                        const next = [...variables];
                                                        next[i] = e.target.value;
                                                        setVariables(next);
                                                    }}
                                                    placeholder={`Isi nilai untuk {{${idx}}}`}
                                                />
                                            </div>
                                        ))}
                                    </div>
                                )}

                                <div className="space-y-1">
                                    <Label className="text-xs text-muted-foreground">Preview</Label>
                                    <div className="rounded-md border bg-[#d9fdd3] p-3 text-sm text-black space-y-2">
                                        {headerText && (
                                            <div className="font-semibold">{headerText}</div>
                                        )}
                                        <p className="leading-relaxed whitespace-pre-wrap">
                                            {bodyText
                                                ? renderBody(selected, variables)
                                                : <span className="italic text-muted-foreground">(template ini tidak punya body)</span>}
                                        </p>
                                        {footerText && (
                                            <div className="text-xs text-muted-foreground">{footerText}</div>
                                        )}
                                    </div>
                                </div>
                            </>
                        )}
                    </div>
                )}

                <DialogFooter>
                    <Button
                        type="button"
                        variant="outline"
                        onClick={() => onOpenChange(false)}
                        disabled={sending}
                    >
                        Batal
                    </Button>
                    <Button
                        type="button"
                        onClick={handleSend}
                        disabled={
                            sending || loadingList || !selected || !allFilled || !!listError
                        }
                    >
                        {sending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                        Kirim ke {phoneNumber}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
