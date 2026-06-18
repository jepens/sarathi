'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { UploadZone } from '@/components/knowledge/upload-zone';
import { DocumentList } from '@/components/dashboard/DocumentList';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { IntegrationInfoBanner } from '@/components/dashboard/IntegrationInfoBanner';
import { FileText, Database, Zap, Loader2, PenLine } from 'lucide-react';

interface DocumentStats {
    total: number;
    total_chunks: number;
}

interface Document {
    id: string;
    file_name: string;
    file_type: string;
    created_at: string;
    chunk_count: number;
}

export default function KnowledgePage() {
    const [documents, setDocuments] = useState<Document[]>([]);
    const [stats, setStats] = useState<DocumentStats>({ total: 0, total_chunks: 0 });
    const [loading, setLoading] = useState(true);

    const fetchDocuments = async () => {
        try {
            const response = await fetch('/api/documents');
            if (!response.ok) throw new Error('Failed to fetch documents');

            const data = await response.json();
            setDocuments(data.documents || []);
            setStats({
                total: data.total || 0,
                total_chunks: data.total_chunks || 0,
            });
        } catch (error) {
            console.error('Error fetching documents:', error);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        fetchDocuments();
    }, []);

    const handleUploadComplete = () => {
        fetchDocuments();
    };

    const aiReadiness = stats.total > 0 ? 100 : 0;

    return (
        <div className="space-y-4 sm:space-y-8">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                <div className="space-y-1">
                    <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">Knowledge Base</h1>
                    <p className="text-muted-foreground">
                        Manage your business data and AI knowledge sources.
                    </p>
                </div>
                <Link href="/dashboard/knowledge/editor" className="w-full sm:w-auto">
                    <Button className="w-full sm:w-auto">
                        <PenLine className="mr-2 h-4 w-4" />
                        Tulis / Edit Konten
                    </Button>
                </Link>
            </div>

            {/* AI Integration Info */}
            <IntegrationInfoBanner type="knowledge" />

            <div className="grid gap-4 md:grid-cols-3">
                <Card>
                    <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                        <CardTitle className="text-sm font-medium">Total Documents</CardTitle>
                        <FileText className="h-4 w-4 text-muted-foreground" />
                    </CardHeader>
                    <CardContent>
                        {loading ? (
                            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                        ) : (
                            <>
                                <div className="text-2xl font-bold">{stats.total}</div>
                                <p className="text-xs text-muted-foreground">
                                    {stats.total_chunks} total chunks
                                </p>
                            </>
                        )}
                    </CardContent>
                </Card>
                <Card>
                    <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                        <CardTitle className="text-sm font-medium">Vector Index</CardTitle>
                        <Database className="h-4 w-4 text-muted-foreground" />
                    </CardHeader>
                    <CardContent>
                        {loading ? (
                            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                        ) : (
                            <>
                                <div className="text-2xl font-bold">
                                    {stats.total_chunks > 0 ? 'Synced' : 'Empty'}
                                </div>
                                <p className="text-xs text-muted-foreground">
                                    {stats.total_chunks} vectors indexed
                                </p>
                            </>
                        )}
                    </CardContent>
                </Card>
                <Card>
                    <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                        <CardTitle className="text-sm font-medium">AI Readiness</CardTitle>
                        <Zap className="h-4 w-4 text-muted-foreground" />
                    </CardHeader>
                    <CardContent>
                        {loading ? (
                            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                        ) : (
                            <>
                                <div className="text-2xl font-bold">{aiReadiness}%</div>
                                <p className="text-xs text-muted-foreground">
                                    {aiReadiness === 100 ? 'Ready to answer' : 'Upload documents to start'}
                                </p>
                            </>
                        )}
                    </CardContent>
                </Card>
            </div>

            <div className="grid gap-4 sm:gap-8 md:grid-cols-2">
                <div className="space-y-4">
                    <h2 className="text-xl font-semibold">Upload New Data</h2>
                    <UploadZone onUploadComplete={handleUploadComplete} />
                </div>

                <div className="space-y-4">
                    <h2 className="text-xl font-semibold">Your Documents</h2>
                    {loading ? (
                        <div className="flex items-center justify-center p-8">
                            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
                        </div>
                    ) : (
                        <DocumentList documents={documents} onDocumentDeleted={fetchDocuments} />
                    )}
                </div>
            </div>
        </div>
    );
}
