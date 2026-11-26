import {
    Card,
    CardDescription,
    CardHeader,
    CardTitle,
} from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { CheckCircle2, XCircle } from 'lucide-react';

// Every org's WhatsApp number is connected by the Sarathi team: its
// credentials are kept in Supabase Vault (Fase 2 task 2.2d). This card is
// read-only and only says whether the org's number is active. No callback
// URL, verify token or credential is shown to anyone.
export function WhatsAppCredentials({ connected }: { connected: boolean }) {
    return (
        <Card>
            <CardHeader>
                <CardTitle className="flex items-center justify-between">
                    Dikelola tim Sarathi
                    {connected ? (
                        <Badge className="bg-green-500/15 text-green-500 border-green-500/20">
                            <CheckCircle2 className="w-3 h-3 mr-1" /> Terhubung
                        </Badge>
                    ) : (
                        <Badge variant="secondary">
                            <XCircle className="w-3 h-3 mr-1" /> Belum dihubungkan
                        </Badge>
                    )}
                </CardTitle>
                <CardDescription>
                    Nomor WhatsApp organisasi Anda dihubungkan dan dikelola oleh tim
                    Sarathi. Hubungi tim Sarathi untuk menghubungkan atau mengganti nomor.
                </CardDescription>
            </CardHeader>
        </Card>
    );
}
