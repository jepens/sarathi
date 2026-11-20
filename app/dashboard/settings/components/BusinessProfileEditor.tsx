'use client';

import { useState } from 'react';
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
import { toast } from 'sonner';
import { Loader2, Save } from 'lucide-react';
import type { BusinessProfile } from '@/lib/settings/business-profile';
import { updateBusinessProfile } from '../actions';

const FIELDS: {
    key: keyof BusinessProfile;
    label: string;
    placeholder?: string;
}[] = [
    { key: 'businessName', label: 'Nama Bisnis', placeholder: 'mis. Cahaya Event Organizer' },
    { key: 'assistantName', label: 'Nama Asisten (persona AI)', placeholder: 'mis. Rina' },
    { key: 'specialties', label: 'Spesialisasi', placeholder: 'mis. Pernikahan, Gathering Kantor' },
    { key: 'establishedYear', label: 'Tahun Berdiri', placeholder: 'mis. 2020' },
    { key: 'serviceAreas', label: 'Area Layanan', placeholder: 'mis. Surabaya dan sekitarnya' },
    { key: 'handoffName', label: 'Nama Kontak Hand-off', placeholder: 'mis. Budi (Lead Consultant)' },
    { key: 'handoffPhone', label: 'No. Hand-off (WhatsApp)', placeholder: '+62 812-xxxx-xxxx' },
    { key: 'businessEmail', label: 'Email Bisnis', placeholder: 'info@bisnis.co.id' },
    { key: 'website', label: 'Website', placeholder: 'bisnis.co.id' },
];

export function BusinessProfileEditor({ initial }: { initial: BusinessProfile }) {
    const [form, setForm] = useState<BusinessProfile>(initial);
    const [saving, setSaving] = useState(false);

    const set = (k: keyof BusinessProfile, v: string) =>
        setForm((f) => ({ ...f, [k]: v }));

    const handleSave = async () => {
        setSaving(true);
        const promise = (async () => {
            const res = await updateBusinessProfile(form);
            if (!res.ok) throw new Error(res.error ?? 'Gagal menyimpan profil bisnis');
        })();
        toast.promise(promise, {
            loading: 'Menyimpan profil…',
            success: 'Profil bisnis disimpan',
            error: (e) => (e instanceof Error ? e.message : 'Gagal menyimpan profil bisnis'),
        });
        try {
            await promise;
        } catch {
            /* error already surfaced by toast.promise */
        } finally {
            setSaving(false);
        }
    };

    return (
        <Card>
            <CardHeader>
                <CardTitle>Profil Bisnis</CardTitle>
                <CardDescription>
                    Identitas bisnis yang dipakai asisten AI (nama, persona, kontak,
                    area layanan). Field ini mengisi otomatis system message default
                    dan kontak hand-off.
                </CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
                <div className="grid gap-4 sm:grid-cols-2">
                    {FIELDS.map((f) => (
                        <div key={f.key} className="space-y-2">
                            <Label htmlFor={f.key}>{f.label}</Label>
                            <Input
                                id={f.key}
                                value={form[f.key]}
                                placeholder={f.placeholder}
                                onChange={(e) => set(f.key, e.target.value)}
                            />
                        </div>
                    ))}
                </div>
                <div className="flex border-t pt-4">
                    <Button onClick={handleSave} disabled={saving}>
                        {saving ? (
                            <>
                                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                                Menyimpan...
                            </>
                        ) : (
                            <>
                                <Save className="mr-2 h-4 w-4" />
                                Simpan Profil
                            </>
                        )}
                    </Button>
                </div>
            </CardContent>
        </Card>
    );
}
