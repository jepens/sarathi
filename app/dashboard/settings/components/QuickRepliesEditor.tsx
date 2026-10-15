'use client';

import { useCallback, useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { useCurrentOrgId } from '@/components/current-org-provider';
import { NO_ORG_MESSAGE } from '@/lib/settings/org-access';
import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
} from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
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
import { Loader2, Plus, Pencil, Trash2, X, Zap } from 'lucide-react';
import type { QuickReply } from '@/lib/quick-replies';

// Shortcut is typed after "/" in the composer, so keep it to a single lowercase
// token: letters/digits/dash/underscore, no spaces.
function normalizeShortcut(raw: string): string {
    return raw
        .toLowerCase()
        .replace(/\s+/g, '-')
        .replace(/[^a-z0-9_-]/g, '')
        .slice(0, 40);
}

export function QuickRepliesEditor() {
    const supabase = createClient();
    // Explicit org for reads + inserts (see LabelsEditor).
    const orgId = useCurrentOrgId();
    const [items, setItems] = useState<QuickReply[]>([]);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);

    // Add/edit form. editingId === null → adding a new one.
    const [editingId, setEditingId] = useState<string | null>(null);
    const [shortcut, setShortcut] = useState('');
    const [content, setContent] = useState('');
    const [deleteTarget, setDeleteTarget] = useState<QuickReply | null>(null);
    const [deleting, setDeleting] = useState(false);

    const fetchItems = useCallback(async () => {
        if (!orgId) {
            setItems([]);
            setLoading(false);
            return;
        }
        const { data, error } = await supabase
            .from('quick_replies')
            .select('id, shortcut, content')
            .eq('org_id', orgId)
            .order('shortcut', { ascending: true });
        if (error) {
            toast.error('Gagal memuat balasan cepat');
        } else {
            setItems(data ?? []);
        }
        setLoading(false);
    }, [supabase, orgId]);

    useEffect(() => {
        fetchItems();
    }, [fetchItems]);

    const resetForm = () => {
        setEditingId(null);
        setShortcut('');
        setContent('');
    };

    const startEdit = (qr: QuickReply) => {
        setEditingId(qr.id);
        setShortcut(qr.shortcut);
        setContent(qr.content);
    };

    const handleSave = async () => {
        const sc = normalizeShortcut(shortcut);
        const body = content.trim();
        if (!sc) {
            toast.error('Shortcut wajib diisi (huruf/angka, tanpa spasi).');
            return;
        }
        if (!body) {
            toast.error('Isi pesan wajib diisi.');
            return;
        }
        if (!orgId) {
            toast.error(NO_ORG_MESSAGE);
            return;
        }
        setSaving(true);
        try {
            if (editingId) {
                const { data, error } = await supabase
                    .from('quick_replies')
                    .update({ shortcut: sc, content: body, updated_at: new Date().toISOString() })
                    .eq('id', editingId)
                    .select('id');
                if (error) throw error;
                // A zero-row UPDATE (row deleted in another tab/by another admin)
                // is NOT an error in PostgREST — detect it so we don't toast a
                // false "saved".
                if (!data || data.length === 0) {
                    throw new Error('Balasan cepat ini sudah tidak ada (mungkin dihapus). Muat ulang halaman.');
                }
                toast.success('Balasan cepat diperbarui');
            } else {
                const { error } = await supabase
                    .from('quick_replies')
                    .insert({ org_id: orgId, shortcut: sc, content: body });
                if (error) throw error;
                toast.success('Balasan cepat ditambahkan');
            }
            resetForm();
            await fetchItems();
        } catch (e) {
            const err = e as { code?: string; message?: string };
            if (err.code === '23505') {
                toast.error(`Shortcut "/${sc}" sudah dipakai. Pilih yang lain.`);
            } else {
                toast.error(err.message ?? 'Gagal menyimpan balasan cepat');
            }
        } finally {
            setSaving(false);
        }
    };

    const handleDelete = async () => {
        if (!deleteTarget) return;
        setDeleting(true);
        try {
            const { error } = await supabase.from('quick_replies').delete().eq('id', deleteTarget.id);
            if (error) throw error;
            if (editingId === deleteTarget.id) resetForm();
            setDeleteTarget(null);
            toast.success('Balasan cepat dihapus');
            await fetchItems();
        } catch (e) {
            toast.error(e instanceof Error ? e.message : 'Gagal menghapus');
        } finally {
            setDeleting(false);
        }
    };

    return (
        <Card>
            <CardHeader>
                <CardTitle className="flex items-center gap-2">
                    <Zap className="h-5 w-5 text-emerald-600" />
                    Balasan Cepat
                </CardTitle>
                <CardDescription>
                    Simpan jawaban yang sering dipakai. Di chat, panggil lewat tombol ⚡
                    atau ketik <code className="rounded bg-muted px-1">/shortcut</code> di
                    awal pesan. Variabel yang bisa dipakai:{' '}
                    <code className="rounded bg-muted px-1">{'{nama}'}</code>,{' '}
                    <code className="rounded bg-muted px-1">{'{perusahaan}'}</code>,{' '}
                    <code className="rounded bg-muted px-1">{'{event}'}</code> — otomatis diisi
                    dari data kontak saat disisipkan.
                </CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
                {/* Add / edit form */}
                <div className="space-y-3 rounded-lg border p-4">
                    <div className="space-y-2">
                        <Label htmlFor="qr-shortcut">Shortcut</Label>
                        <div className="flex items-center gap-2">
                            <span className="text-muted-foreground">/</span>
                            <Input
                                id="qr-shortcut"
                                value={shortcut}
                                placeholder="harga"
                                maxLength={40}
                                onChange={(e) => setShortcut(e.target.value)}
                                className="max-w-xs"
                            />
                        </div>
                        <p className="text-xs text-muted-foreground">
                            Tanpa spasi (huruf, angka, - atau _). Dipanggil dengan <code>/{normalizeShortcut(shortcut) || 'shortcut'}</code>.
                        </p>
                    </div>
                    <div className="space-y-2">
                        <Label htmlFor="qr-content">Isi pesan</Label>
                        <Textarea
                            id="qr-content"
                            value={content}
                            placeholder="Halo {nama}, untuk acara {event} harga paket mulai dari ..."
                            rows={4}
                            onChange={(e) => setContent(e.target.value)}
                        />
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
                                <Skeleton key={i} className="h-16 w-full rounded-lg" />
                            ))}
                        </div>
                    ) : items.length === 0 ? (
                        <p className="py-6 text-center text-sm text-muted-foreground">
                            Belum ada balasan cepat. Tambahkan yang pertama di atas.
                        </p>
                    ) : (
                        items.map((qr) => (
                            <div
                                key={qr.id}
                                className="flex items-start justify-between gap-3 rounded-lg border p-3"
                            >
                                <div className="min-w-0 flex-1">
                                    <code className="rounded bg-muted px-1.5 py-0.5 text-xs font-medium text-emerald-700 dark:text-emerald-400">
                                        /{qr.shortcut}
                                    </code>
                                    <p className="mt-1 whitespace-pre-wrap break-words text-sm text-muted-foreground">
                                        {qr.content}
                                    </p>
                                </div>
                                <div className="flex shrink-0 gap-1">
                                    <Button
                                        variant="ghost"
                                        size="icon"
                                        aria-label={`Edit /${qr.shortcut}`}
                                        onClick={() => startEdit(qr)}
                                    >
                                        <Pencil className="h-4 w-4" />
                                    </Button>
                                    <Button
                                        variant="ghost"
                                        size="icon"
                                        aria-label={`Hapus /${qr.shortcut}`}
                                        className="text-red-600 hover:text-red-600 dark:text-red-400"
                                        onClick={() => setDeleteTarget(qr)}
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
                        <DialogTitle>Hapus balasan cepat?</DialogTitle>
                        <DialogDescription>
                            <code>/{deleteTarget?.shortcut}</code> akan dihapus permanen.
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
