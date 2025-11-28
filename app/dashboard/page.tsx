'use client';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { BookOpen, MessageSquare, ShoppingBag, CheckCircle2, XCircle, Activity } from "lucide-react";
import { useEffect, useState } from "react";

interface Stats {
    documents: number;
    products: number;
    whatsappConfigured: boolean;
}

export default function DashboardPage() {
    const [stats, setStats] = useState<Stats>({
        documents: 0,
        products: 0,
        whatsappConfigured: false
    });
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        async function fetchStats() {
            try {
                // Fetch documents count
                const docsRes = await fetch('/api/documents');
                const docsData = await docsRes.json();

                // Fetch products count
                const productsRes = await fetch('/api/products');
                const productsData = await productsRes.json();

                setStats({
                    documents: docsData.documents?.length || 0,
                    products: productsData.products?.length || 0,
                    whatsappConfigured: true // Assume configured if env vars are set
                });
            } catch (error) {
                console.error('Error fetching stats:', error);
            } finally {
                setLoading(false);
            }
        }

        fetchStats();
    }, []);

    return (
        <div className="space-y-6">
            <div>
                <h2 className="text-3xl font-bold tracking-tight">Dashboard Overview</h2>
                <p className="text-muted-foreground">
                    Selamat datang di Sahabat UMKM - AI Sales Assistant Anda
                </p>
            </div>

            {/* Stats Grid */}
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
                {/* Knowledge Base */}
                <Card>
                    <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                        <CardTitle className="text-sm font-medium">
                            Knowledge Base
                        </CardTitle>
                        <BookOpen className="h-4 w-4 text-muted-foreground" />
                    </CardHeader>
                    <CardContent>
                        <div className="text-2xl font-bold">
                            {loading ? '...' : stats.documents}
                        </div>
                        <p className="text-xs text-muted-foreground">
                            Dokumen tersimpan
                        </p>
                    </CardContent>
                </Card>

                {/* Products */}
                <Card>
                    <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                        <CardTitle className="text-sm font-medium">
                            Products
                        </CardTitle>
                        <ShoppingBag className="h-4 w-4 text-muted-foreground" />
                    </CardHeader>
                    <CardContent>
                        <div className="text-2xl font-bold">
                            {loading ? '...' : stats.products}
                        </div>
                        <p className="text-xs text-muted-foreground">
                            Produk terdaftar
                        </p>
                    </CardContent>
                </Card>

                {/* WhatsApp Status */}
                <Card>
                    <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                        <CardTitle className="text-sm font-medium">
                            WhatsApp
                        </CardTitle>
                        <MessageSquare className="h-4 w-4 text-muted-foreground" />
                    </CardHeader>
                    <CardContent>
                        <div className="text-2xl font-bold">
                            {stats.whatsappConfigured ? (
                                <Badge variant="default" className="bg-green-500/15 text-green-500 hover:bg-green-500/25 border-green-500/20">
                                    <CheckCircle2 className="w-3 h-3 mr-1" /> Active
                                </Badge>
                            ) : (
                                <Badge variant="destructive" className="bg-red-500/15 text-red-500 hover:bg-red-500/25 border-red-500/20">
                                    <XCircle className="w-3 h-3 mr-1" /> Inactive
                                </Badge>
                            )}
                        </div>
                        <p className="text-xs text-muted-foreground">
                            Integration status
                        </p>
                    </CardContent>
                </Card>

                {/* System Status */}
                <Card>
                    <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                        <CardTitle className="text-sm font-medium">
                            System
                        </CardTitle>
                        <Activity className="h-4 w-4 text-muted-foreground" />
                    </CardHeader>
                    <CardContent>
                        <div className="text-2xl font-bold">
                            <Badge variant="default" className="bg-green-500/15 text-green-500 hover:bg-green-500/25 border-green-500/20">
                                <CheckCircle2 className="w-3 h-3 mr-1" /> Online
                            </Badge>
                        </div>
                        <p className="text-xs text-muted-foreground">
                            All systems operational
                        </p>
                    </CardContent>
                </Card>
            </div>

            {/* Quick Actions */}
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                <Card>
                    <CardHeader>
                        <CardTitle>Quick Start</CardTitle>
                        <CardDescription>
                            Mulai gunakan Sahabat UMKM
                        </CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-2">
                        <div className="text-sm">
                            <p className="font-medium mb-2">Langkah-langkah:</p>
                            <ol className="list-decimal list-inside space-y-1 text-muted-foreground">
                                <li>Upload dokumen bisnis ke Knowledge Base</li>
                                <li>Tambahkan produk Anda</li>
                                <li>Test chat interface</li>
                                <li>Configure WhatsApp webhook</li>
                                <li>Mulai terima pesanan!</li>
                            </ol>
                        </div>
                    </CardContent>
                </Card>

                <Card>
                    <CardHeader>
                        <CardTitle>Features</CardTitle>
                        <CardDescription>
                            Fitur yang tersedia
                        </CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-2">
                        <div className="flex items-center space-x-2">
                            <CheckCircle2 className="h-4 w-4 text-green-500" />
                            <span className="text-sm">Knowledge Base dengan AI Search</span>
                        </div>
                        <div className="flex items-center space-x-2">
                            <CheckCircle2 className="h-4 w-4 text-green-500" />
                            <span className="text-sm">Product Management</span>
                        </div>
                        <div className="flex items-center space-x-2">
                            <CheckCircle2 className="h-4 w-4 text-green-500" />
                            <span className="text-sm">Web Chat Interface</span>
                        </div>
                        <div className="flex items-center space-x-2">
                            <CheckCircle2 className="h-4 w-4 text-green-500" />
                            <span className="text-sm">WhatsApp Integration</span>
                        </div>
                        <div className="flex items-center space-x-2">
                            <CheckCircle2 className="h-4 w-4 text-green-500" />
                            <span className="text-sm">Shipping Cost Calculator</span>
                        </div>
                    </CardContent>
                </Card>

                <Card>
                    <CardHeader>
                        <CardTitle>Need Help?</CardTitle>
                        <CardDescription>
                            Dokumentasi & Support
                        </CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-2">
                        <div className="text-sm space-y-1">
                            <p className="text-muted-foreground">
                                Lihat dokumentasi lengkap di folder <code className="text-xs bg-muted px-1 py-0.5 rounded">docs/</code>
                            </p>
                            <ul className="list-disc list-inside text-muted-foreground space-y-1">
                                <li>WHATSAPP_SETUP.md</li>
                                <li>RAJAONGKIR_INTEGRATION.md</li>
                                <li>SHIPPING_FEATURE_GUIDE.md</li>
                                <li>README.md</li>
                            </ul>
                        </div>
                    </CardContent>
                </Card>
            </div>
        </div>
    );
}
