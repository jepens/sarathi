'use client';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import { toast } from 'sonner';
import { ArrowLeft, Loader2, Save, FileText, Trash2, Plus, AlertTriangle } from 'lucide-react';
import { KB_TEMPLATES, getKbTemplate } from '@/lib/knowledge/templates';

interface KbSource {
    id: string;
    title: string;
    updated_at: string;
}

export default function KnowledgeEditorPage() {
    const [sources, setSources] = useState<KbSource[]>([]);
    const [title, setTitle] = useState('');
    const [content, setContent] = useState('');
    const [saving, setSaving] = useState(false);
    const [loadingSources, setLoadingSources] = useState(true);
    const [loadingDoc, setLoadingDoc] = useState(false);
    const [toDelete, setToDelete] = useState<string | null>(null);

    const fetchSources = useCallback(async () => {
        try {
            const res = await fetch('/api/knowledge/text');
            if (!res.ok) throw new Error('Gagal memuat daftar');
            const data = await res.json();
            setSources(data.sources ?? []);
        } catch (e) {
            console.error(e);
        } finally {
            setLoadingSources(false);
        }
    }, []);

    useEffect(() => {
        fetchSources();
    }, [fetchSources]);

    const loadTemplate = (templateId: string) => {
        const t = getKbTemplate(templateId);
        if (!t) return;
        setTitle(t.title);
        setContent(t.content);
        toast.info(`Template "${t.title}" dimuat. Edit lalu Simpan.`);
    };

    const loadSource = async (sourceTitle: string) => {
        setLoadingDoc(true);
        try {
            const res = await fetch(`/api/knowledge/text?title=${encodeURIComponent(sourceTitle)}`);
            if (!res.ok) throw new Error('Gagal memuat dokumen');
            const data = await res.json();
            setTitle(data.source.title);
            setContent(data.source.content);
        } catch (e) {
            console.error(e);
            toast.error('Gagal memuat dokumen');
        } finally {
            setLoadingDoc(false);
        }
    };

    const handleNew = () => {
        setTitle('');
        setContent('');
    };

    const handleSave = async () => {
        if (!title.trim()) {
            toast.error('Judul wajib diisi');
            return;
        }
        if (!content.trim()) {
            toast.error('Konten tidak boleh kosong');
            return;
        }
        setSaving(true);
        try {
            const res = await fetch('/api/knowledge/text', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ title: title.trim(), content }),
            });
            const data = (await res.json().catch(() => ({}))) as { error?: string; chunks?: number };
            if (!res.ok) throw new Error(data.error || 'Gagal menyimpan');
            toast.success(`Tersimpan ke Knowledge Base (${data.chunks} chunk, embedding dibuat).`);
            fetchSources();
        } catch (e) {
            toast.error(e instanceof Error ? e.message : 'Gagal menyimpan');
        } finally {
            setSaving(false);
        }
    };

    const confirmDelete = async () => {
        if (!toDelete) return;
        const t = toDelete;
        setToDelete(null);
        try {
            const res = await fetch(`/api/knowledge/text?title=${encodeURIComponent(t)}`, {
                method: 'DELETE',
            });
            if (!res.ok) throw new Error('Gagal menghapus');
            toast.success('Dokumen dihapus dari Knowledge Base');
            if (title === t) handleNew();
            fetchSources();
        } catch (e) {
            toast.error(e instanceof Error ? e.message : 'Gagal menghapus');
        }
    };

    return (
        <div className="space-y-4 sm:space-y-6">
            <div className="flex items-center justify-between">
                <div className="space-y-1">
                    <Link
                        href="/dashboard/knowledge"
                        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
                    >
                        <ArrowLeft className="h-4 w-4" /> Knowledge Base
                    </Link>
                    <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">Tulis / Edit Konten</h1>
                    <p className="text-muted-foreground">
                        Tulis konten langsung di sini — tanpa upload file. Saat disimpan, otomatis dipecah & di-embed agar bisa dipakai AI.
                    </p>
                </div>
            </div>

            <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_300px]">
                {/* Editor */}
                <div className="space-y-4">
                    <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end">
                        <div className="space-y-1">
                            <Label className="text-xs text-muted-foreground">Muat template</Label>
                            <Select onValueChange={loadTemplate}>
                                <SelectTrigger className="w-full sm:w-[260px]">
                                    <SelectValue placeholder="Pilih template untuk diisi" />
                                </SelectTrigger>
                                <SelectContent>
                                    {KB_TEMPLATES.map((t) => (
                                        <SelectItem key={t.id} value={t.id}>
                                            {t.title}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </div>
                        <Button variant="outline" onClick={handleNew} type="button" className="self-start sm:self-auto">
                            <Plus className="mr-2 h-4 w-4" /> Kosong
                        </Button>
                    </div>

                    <div className="space-y-2">
                        <Label htmlFor="kb-title">Judul dokumen</Label>
                        <Input
                            id="kb-title"
                            value={title}
                            onChange={(e) => setTitle(e.target.value)}
                            placeholder="mis. Layanan & Paket Acara"
                        />
                        <p className="text-xs text-muted-foreground">
                            Menyimpan dengan judul yang sama akan <strong>menimpa</strong> dokumen sebelumnya (bukan duplikat).
                        </p>
                    </div>

                    <div className="space-y-2">
                        <Label htmlFor="kb-content">Konten</Label>
                        <Textarea
                            id="kb-content"
                            value={content}
                            onChange={(e) => setContent(e.target.value)}
                            placeholder="Tulis konten di sini, atau muat template di atas lalu isi bagian [ISI: ...]"
                            className="min-h-[300px] sm:min-h-[380px] md:min-h-[460px] font-mono text-sm leading-relaxed"
                            disabled={loadingDoc}
                        />
                        <p className="text-xs text-muted-foreground">
                            {content.length.toLocaleString('id-ID')} karakter. Ganti semua placeholder <code>[ISI: ...]</code> dengan data asli sebelum menyimpan.
                        </p>
                    </div>

                    <div className="flex justify-end">
                        <Button onClick={handleSave} disabled={saving || loadingDoc}>
                            {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
                            Simpan ke Knowledge Base
                        </Button>
                    </div>
                </div>

                {/* Saved sources */}
                <Card className="h-fit">
                    <CardHeader className="pb-3">
                        <CardTitle className="text-sm font-medium">Dokumen tersimpan</CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-2">
                        {loadingSources ? (
                            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                        ) : sources.length === 0 ? (
                            <p className="text-xs text-muted-foreground">
                                Belum ada. Muat template, isi, lalu simpan.
                            </p>
                        ) : (
                            sources.map((s) => (
                                <div
                                    key={s.id}
                                    className="group flex items-center justify-between gap-2 rounded-md border border-white/10 bg-black/20 p-2"
                                >
                                    <button
                                        type="button"
                                        onClick={() => loadSource(s.title)}
                                        className="flex min-w-0 flex-1 items-center gap-2 text-left"
                                    >
                                        <FileText className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
                                        <span className="truncate text-xs">{s.title}</span>
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => setToDelete(s.title)}
                                        className="-m-1 p-1 text-muted-foreground hover:text-destructive"
                                        aria-label={`Hapus ${s.title}`}
                                    >
                                        <Trash2 className="h-3.5 w-3.5" />
                                    </button>
                                </div>
                            ))
                        )}
                    </CardContent>
                </Card>
            </div>

            <Dialog open={!!toDelete} onOpenChange={(open) => !open && setToDelete(null)}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle className="flex items-center gap-2 text-destructive">
                            <AlertTriangle className="h-5 w-5" /> Hapus Dokumen
                        </DialogTitle>
                        <DialogDescription>
                            Hapus <strong>{toDelete}</strong> dari Knowledge Base? Semua chunk + embedding-nya ikut terhapus. Aksi ini tidak bisa dibatalkan.
                        </DialogDescription>
                    </DialogHeader>
                    <DialogFooter>
                        <Button variant="outline" onClick={() => setToDelete(null)}>
                            Batal
                        </Button>
                        <Button variant="destructive" onClick={confirmDelete}>
                            Hapus
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    );
}
