'use client';

import { useCallback, useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
} from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label as FieldLabel } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import { toast } from 'sonner';
import { Loader2, Plus, Pencil, Trash2, X, Tag, Check } from 'lucide-react';
import { cn } from '@/lib/utils';
import { LabelBadge } from '@/components/dashboard/LabelBadge';
import {
    LABEL_COLORS,
    DEFAULT_LABEL_COLOR,
    MAX_LABEL_NAME,
    normalizeLabelName,
    sortLabels,
    type Label,
} from '@/lib/labels';

export function LabelsEditor() {
    const supabase = createClient();
    const [items, setItems] = useState<Label[]>([]);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);

    // Add/edit form. editingId === null → adding a new one.
    const [editingId, setEditingId] = useState<string | null>(null);
    const [name, setName] = useState('');
    const [color, setColor] = useState<string>(DEFAULT_LABEL_COLOR);
    const [deleteTarget, setDeleteTarget] = useState<Label | null>(null);
    const [deleting, setDeleting] = useState(false);

    const fetchItems = useCallback(async () => {
        const { data, error } = await supabase.from('labels').select('id, name, color');
        if (error) {
            toast.error('Gagal memuat label');
        } else {
            setItems(sortLabels(data ?? []));
        }
        setLoading(false);
    }, [supabase]);

    useEffect(() => {
        fetchItems();
    }, [fetchItems]);

    const resetForm = () => {
        setEditingId(null);
        setName('');
        setColor(DEFAULT_LABEL_COLOR);
    };

    const startEdit = (lbl: Label) => {
        setEditingId(lbl.id);
        setName(lbl.name);
        setColor(lbl.color);
    };

    const handleSave = async () => {
        const cleanName = normalizeLabelName(name);
        if (!cleanName) {
            toast.error('Nama label wajib diisi.');
            return;
        }
        setSaving(true);
        try {
            if (editingId) {
                const { data, error } = await supabase
                    .from('labels')
                    .update({ name: cleanName, color, updated_at: new Date().toISOString() })
                    .eq('id', editingId)
                    .select('id');
                if (error) throw error;
                // A zero-row UPDATE (row deleted elsewhere) is not an error in
                // PostgREST — detect it so we don't toast a false "saved".
                if (!data || data.length === 0) {
                    throw new Error('Label ini sudah tidak ada (mungkin dihapus). Muat ulang halaman.');
                }
                toast.success('Label diperbarui');
            } else {
                const { error } = await supabase.from('labels').insert({ name: cleanName, color });
                if (error) throw error;
                toast.success('Label ditambahkan');
            }
            resetForm();
            await fetchItems();
        } catch (e) {
            const err = e as { code?: string; message?: string };
            if (err.code === '23505') {
                toast.error(`Label "${cleanName}" sudah ada. Pilih nama lain.`);
            } else {
                toast.error(err.message ?? 'Gagal menyimpan label');
            }
        } finally {
            setSaving(false);
        }
    };

    const handleDelete = async () => {
        if (!deleteTarget) return;
        setDeleting(true);
        try {
            const { error } = await supabase.from('labels').delete().eq('id', deleteTarget.id);
            if (error) throw error;
            if (editingId === deleteTarget.id) resetForm();
            setDeleteTarget(null);
            toast.success('Label dihapus');
            await fetchItems();
        } catch (e) {
            toast.error(e instanceof Error ? e.message : 'Gagal menghapus');
        } finally {
            setDeleting(false);
        }
    };

    const previewName = normalizeLabelName(name) || 'Label';

    return (
        <Card>
            <CardHeader>
                <CardTitle className="flex items-center gap-2">
                    <Tag className="h-5 w-5 text-emerald-600" />
                    Label
                </CardTitle>
                <CardDescription>
                    Kelompokkan chat dengan label berwarna (mis. <em>VIP</em>,{' '}
                    <em>Menunggu Pembayaran</em>). Tempelkan label ke chat lewat tombol 🏷️ di
                    header percakapan, lalu saring daftar chat berdasarkan label. Label ini
                    hanya ada di Sarathi — tidak ikut tersinkron ke aplikasi WhatsApp.
                </CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
                {/* Add / edit form */}
                <div className="space-y-3 rounded-lg border p-4">
                    <div className="space-y-2">
                        <FieldLabel htmlFor="label-name">Nama label</FieldLabel>
                        <Input
                            id="label-name"
                            value={name}
                            placeholder="VIP"
                            maxLength={MAX_LABEL_NAME}
                            onChange={(e) => setName(e.target.value)}
                            className="max-w-xs"
                        />
                    </div>
                    <div className="space-y-2">
                        <FieldLabel>Warna</FieldLabel>
                        <div className="flex flex-wrap gap-2">
                            {LABEL_COLORS.map((c) => {
                                const selected = color === c.key;
                                return (
                                    <button
                                        key={c.key}
                                        type="button"
                                        onClick={() => setColor(c.key)}
                                        title={c.name}
                                        aria-label={c.name}
                                        aria-pressed={selected}
                                        className={cn(
                                            'flex h-7 w-7 items-center justify-center rounded-full transition',
                                            c.swatch,
                                            selected
                                                ? 'ring-2 ring-black/60 dark:ring-white/80'
                                                : 'ring-1 ring-black/10 hover:ring-black/30 dark:ring-white/20 dark:hover:ring-white/40',
                                        )}
                                    >
                                        {selected && <Check className="h-4 w-4 text-white drop-shadow" />}
                                    </button>
                                );
                            })}
                        </div>
                    </div>
                    <div className="flex items-center gap-3 pt-1">
                        <span className="text-xs text-muted-foreground">Pratinjau:</span>
                        <LabelBadge label={{ name: previewName, color }} />
                    </div>
                    <div className="flex items-center gap-2">
                        <Button onClick={handleSave} disabled={saving}>
                            {saving ? (
                                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                            ) : editingId ? (
                                <Pencil className="mr-2 h-4 w-4" />
                            ) : (
                                <Plus className="mr-2 h-4 w-4" />
                            )}
                            {editingId ? 'Simpan perubahan' : 'Tambah'}
                        </Button>
                        {editingId && (
                            <Button variant="ghost" onClick={resetForm} disabled={saving}>
                                <X className="mr-2 h-4 w-4" />
                                Batal
                            </Button>
                        )}
                    </div>
                </div>

                {/* List */}
                <div className="space-y-2">
                    {loading ? (
                        <div className="space-y-2">
                            {Array.from({ length: 3 }).map((_, i) => (
                                <Skeleton key={i} className="h-12 w-full rounded-lg" />
                            ))}
                        </div>
                    ) : items.length === 0 ? (
                        <p className="py-6 text-center text-sm text-muted-foreground">
                            Belum ada label. Tambahkan yang pertama di atas.
                        </p>
                    ) : (
                        items.map((lbl) => (
                            <div
                                key={lbl.id}
                                className="flex items-center justify-between gap-3 rounded-lg border p-3"
                            >
                                <LabelBadge label={lbl} className="min-w-0" />
                                <div className="flex shrink-0 gap-1">
                                    <Button
                                        variant="ghost"
                                        size="icon"
                                        aria-label={`Edit label ${lbl.name}`}
                                        onClick={() => startEdit(lbl)}
                                    >
                                        <Pencil className="h-4 w-4" />
                                    </Button>
                                    <Button
                                        variant="ghost"
                                        size="icon"
                                        aria-label={`Hapus label ${lbl.name}`}
                                        className="text-red-600 hover:text-red-600 dark:text-red-400"
                                        onClick={() => setDeleteTarget(lbl)}
                                    >
                                        <Trash2 className="h-4 w-4" />
                                    </Button>
                                </div>
                            </div>
                        ))
                    )}
                </div>
            </CardContent>

            <Dialog open={!!deleteTarget} onOpenChange={(o) => { if (!deleting && !o) setDeleteTarget(null); }}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>Hapus label?</DialogTitle>
                        <DialogDescription>
                            Label <strong>{deleteTarget?.name}</strong> akan dihapus permanen dan
                            dilepas dari semua chat yang memakainya. Pesan &amp; chat tidak terpengaruh.
                        </DialogDescription>
                    </DialogHeader>
                    <DialogFooter>
                        <Button variant="outline" onClick={() => setDeleteTarget(null)} disabled={deleting}>
                            Batal
                        </Button>
                        <Button variant="destructive" onClick={handleDelete} disabled={deleting}>
                            {deleting ? 'Menghapus…' : 'Hapus'}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </Card>
    );
}
