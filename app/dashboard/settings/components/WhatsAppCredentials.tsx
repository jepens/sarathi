import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
} from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { CheckCircle2, XCircle } from 'lucide-react';

// Single-tenant: WhatsApp credentials come from server environment variables,
// not the database. This card is read-only — it only reports whether the env is
// configured. To change the number/token, edit the env and redeploy.
export function WhatsAppCredentials({ envConfigured }: { envConfigured: boolean }) {
    return (
        <Card>
            <CardHeader>
                <CardTitle className="flex items-center justify-between">
                    Kredensial WhatsApp
                    {envConfigured ? (
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
                    Dikelola lewat environment variable server:{' '}
                    <code className="font-mono text-xs">WHATSAPP_PHONE_NUMBER_ID</code>,{' '}
                    <code className="font-mono text-xs">WHATSAPP_ACCESS_TOKEN</code>,{' '}
                    <code className="font-mono text-xs">WHATSAPP_APP_SECRET</code>. Ubah di
                    konfigurasi server lalu deploy ulang.
                </CardDescription>
            </CardHeader>
            <CardContent className="text-sm text-muted-foreground">
                {envConfigured
                    ? 'Nomor WhatsApp terkonfigurasi dari environment. Asisten memakai nomor ini untuk membalas pesan klien.'
                    : 'Set WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_ACCESS_TOKEN, dan WHATSAPP_APP_SECRET di environment server agar bot bisa menerima & membalas pesan.'}
            </CardContent>
        </Card>
    );
}
