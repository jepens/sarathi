'use client';

import { useState } from 'react';
import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { CheckCircle2, XCircle, Loader2, Save } from 'lucide-react';
import { toast } from 'sonner';
import type { WhatsAppIntegrationView } from '@/lib/whatsapp/integration';
import { saveWhatsAppIntegration } from '../actions';

export function WhatsAppCredentials({
    initial,
}: {
    initial: WhatsAppIntegrationView | null;
}) {
    const [phoneNumberId, setPhoneNumberId] = useState(initial?.phoneNumberId ?? '');
    const [wabaId, setWabaId] = useState(initial?.wabaId ?? '');
    const [displayPhone, setDisplayPhone] = useState(initial?.displayPhone ?? '');
    const [accessToken, setAccessToken] = useState('');
    const [appSecret, setAppSecret] = useState('');
    const [saving, setSaving] = useState(false);

    const configured = !!initial?.phoneNumberId && !!initial?.hasAccessToken;

    const handleSave = async () => {
        setSaving(true);
        const res = await saveWhatsAppIntegration({
            phoneNumberId,
            wabaId,
            displayPhone,
            accessToken,
            appSecret,
        });
        setSaving(false);
        if (res.ok) {
            toast.success('Kredensial WhatsApp disimpan');
            setAccessToken('');
            setAppSecret('');
        } else {
            toast.error(res.error ?? 'Gagal menyimpan kredensial');
        }
    };

    return (
        <Card>
            <CardHeader>
                <CardTitle className="flex items-center justify-between">
                    Kredensial WhatsApp (EO Anda)
                    {configured ? (
                        <Badge className="bg-green-500/15 text-green-500 border-green-500/20">
                            <CheckCircle2 className="w-3 h-3 mr-1" /> Terhubung
                        </Badge>
                    ) : (
                        <Badge variant="destructive" className="bg-red-500/15 text-red-500 border-red-500/20">
                            <XCircle className="w-3 h-3 mr-1" /> Belum diatur
                        </Badge>
                    )}
                </CardTitle>
                <CardDescription>
                    Dari Meta Developer → WhatsApp → API Setup. Nomor inilah yang
                    dipakai asisten untuk membalas klien Anda. Pasang Webhook URL &
                    Verify Token (kartu di bawah) di Meta app Anda.
                </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
                <div className="grid gap-4 sm:grid-cols-2">
                    <div className="space-y-2">
                        <Label htmlFor="phoneNumberId">Phone Number ID</Label>
                        <Input
                            id="phoneNumberId"
                            value={phoneNumberId}
                            onChange={(e) => setPhoneNumberId(e.target.value)}
                            placeholder="1234567890"
                            className="font-mono text-sm"
                        />
                    </div>
                    <div className="space-y-2">
                        <Label htmlFor="displayPhone">Nomor (tampilan)</Label>
                        <Input
                            id="displayPhone"
                            value={displayPhone}
                            onChange={(e) => setDisplayPhone(e.target.value)}
                            placeholder="+62 812-xxxx-xxxx"
                        />
                    </div>
                    <div className="space-y-2">
                        <Label htmlFor="wabaId">WhatsApp Business Account ID</Label>
                        <Input
                            id="wabaId"
                            value={wabaId}
                            onChange={(e) => setWabaId(e.target.value)}
                            placeholder="WABA ID"
                            className="font-mono text-sm"
                        />
                    </div>
                    <div className="space-y-2">
                        <Label htmlFor="accessToken">Access Token</Label>
                        <Input
                            id="accessToken"
                            type="password"
                            value={accessToken}
                            onChange={(e) => setAccessToken(e.target.value)}
                            placeholder={
                                initial?.hasAccessToken
                                    ? '•••••••• (tersimpan — isi untuk ganti)'
                                    : 'Token permanen'
                            }
                            className="font-mono text-sm"
                        />
                    </div>
                    <div className="space-y-2 sm:col-span-2">
                        <Label htmlFor="appSecret">App Secret</Label>
                        <Input
                            id="appSecret"
                            type="password"
                            value={appSecret}
                            onChange={(e) => setAppSecret(e.target.value)}
                            placeholder={
                                initial?.hasAppSecret
                                    ? '•••••••• (tersimpan — isi untuk ganti)'
                                    : 'Meta App → Settings → Basic → App Secret'
                            }
                            className="font-mono text-sm"
                        />
                        <p className="text-xs text-muted-foreground">
                            Wajib: dipakai memverifikasi signature webhook. Tanpa ini,
                            pesan masuk ditolak dan bot tidak akan membalas.
                        </p>
                    </div>
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
                                Simpan Kredensial
                            </>
                        )}
                    </Button>
                </div>
            </CardContent>
        </Card>
    );
}
