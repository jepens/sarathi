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
    { key: 'businessName', label: 'Nama Bisnis', placeholder: 'Sailendra Organizer' },
    { key: 'assistantName', label: 'Nama Asisten (persona AI)', placeholder: 'Nindra' },
    { key: 'specialties', label: 'Spesialisasi', placeholder: 'Team Building, Company Gathering' },
    { key: 'establishedYear', label: 'Tahun Berdiri', placeholder: '2016' },
    { key: 'serviceAreas', label: 'Area Layanan', placeholder: 'Jabodetabek, Bandung, Bali' },
    { key: 'handoffName', label: 'Nama Kontak Hand-off', placeholder: 'MJ (Lead Consultant)' },
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
        const res = await updateBusinessProfile(form);
        setSaving(false);
        if (res.ok) {
            toast.success('Profil bisnis disimpan');
        } else {
            toast.error(res.error ?? 'Gagal menyimpan profil bisnis');
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
