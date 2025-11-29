import { Info, Settings } from 'lucide-react';
import Link from 'next/link';

interface IntegrationInfoBannerProps {
    type: 'knowledge' | 'products';
}

export function IntegrationInfoBanner({ type }: IntegrationInfoBannerProps) {
    const content = {
        knowledge: {
            title: 'AI Integration',
            description: 'Dokumen yang Anda upload akan digunakan oleh AI untuk menjawab pertanyaan pelanggan via WhatsApp. AI akan menggabungkan informasi dari dokumen ini dengan data Products.',
        },
        products: {
            title: 'AI Integration',
            description: 'Produk yang Anda tambahkan akan otomatis tersedia untuk AI. Pelanggan dapat bertanya tentang produk, harga, dan stok via WhatsApp.',
        },
    };

    const current = content[type];

    return (
        <div className="bg-blue-500/10 border border-blue-500/20 rounded-lg p-4">
            <div className="flex items-start gap-3">
                <Info className="h-5 w-5 text-blue-400 mt-0.5 flex-shrink-0" />
                <div className="flex-1 space-y-2">
                    <div>
                        <h4 className="text-sm font-medium text-blue-200">{current.title}</h4>
                        <p className="text-sm text-blue-200/80 mt-1">
                            {current.description}
                        </p>
                    </div>
                    <Link
                        href="/dashboard/settings"
                        className="inline-flex items-center gap-1 text-xs text-blue-300 hover:text-blue-200 transition-colors"
                    >
                        <Settings className="h-3 w-3" />
                        Lihat pengaturan AI di Settings → System Message
                    </Link>
                </div>
            </div>
        </div>
    );
}
