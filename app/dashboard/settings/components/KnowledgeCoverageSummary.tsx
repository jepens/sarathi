'use client';

import { useEffect, useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { FileText, Package, Lightbulb, Loader2 } from 'lucide-react';

interface CoverageSummary {
    totalDocuments: number;
    totalProducts: number;
    documentTopics: string[];
    productCategories: string[];
    suggestions: string[];
}

export function KnowledgeCoverageSummary() {
    const [summary, setSummary] = useState<CoverageSummary | null>(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        fetchSummary();
    }, []);

    const fetchSummary = async () => {
        try {
            const [docsResponse, productsResponse] = await Promise.all([
                fetch('/api/documents'),
                fetch('/api/products')
            ]);

            if (!docsResponse.ok || !productsResponse.ok) {
                throw new Error('Failed to fetch data');
            }

            const docsData = await docsResponse.json();
            const productsData = await productsResponse.json();

            // Extract topics from document filenames
            const topics = docsData.documents?.map((doc: { file_name: string }) => {
                // Extract topic from filename (remove extension)
                const name = doc.file_name.replace(/\.[^/.]+$/, '');
                return name.replace(/_/g, ' ');
            }).slice(0, 5) || [];

            // Extract product names as categories
            const categories = productsData.products?.map((prod: { name: string }) => prod.name).slice(0, 5) || [];

            // Generate simple suggestions
            const suggestions = [];
            if (docsData.total === 0) {
                suggestions.push('Upload dokumen tentang kebijakan toko Anda untuk jawaban AI yang lebih akurat');
            }
            if (productsData.products?.length === 0) {
                suggestions.push('Tambahkan produk agar AI dapat merekomendasikan items ke pelanggan');
            }
            if (docsData.total < 3) {
                suggestions.push('Pertimbangkan menambahkan dokumen FAQ atau Product Guide');
            }

            setSummary({
                totalDocuments: docsData.total || 0,
                totalProducts: productsData.products?.length || 0,
                documentTopics: topics,
                productCategories: categories,
                suggestions
            });
        } catch (error) {
            console.error('Error fetching coverage summary:', error);
        } finally {
            setLoading(false);
        }
    };

    if (loading) {
        return (
            <Card>
                <CardHeader>
                    <CardTitle>Knowledge Coverage</CardTitle>
                    <CardDescription>AI context overview</CardDescription>
                </CardHeader>
                <CardContent className="flex items-center justify-center py-8">
                    <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                </CardContent>
            </Card>
        );
    }

    if (!summary) return null;

    return (
        <Card>
            <CardHeader>
                <CardTitle>Knowledge Coverage</CardTitle>
                <CardDescription>
                    Overview of data available to AI for answering questions
                </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
                {/* Stats Grid */}
                <div className="grid grid-cols-2 gap-3 sm:gap-4">
                    <div className="bg-muted/50 border rounded-lg p-4">
                        <div className="flex items-center gap-2 mb-2">
                            <FileText className="h-4 w-4 text-blue-400" />
                            <span className="text-sm text-muted-foreground">Documents</span>
                        </div>
                        <p className="text-2xl font-bold">{summary.totalDocuments}</p>
                    </div>
                    <div className="bg-muted/50 border rounded-lg p-4">
                        <div className="flex items-center gap-2 mb-2">
                            <Package className="h-4 w-4 text-green-400" />
                            <span className="text-sm text-muted-foreground">Products</span>
                        </div>
                        <p className="text-2xl font-bold">{summary.totalProducts}</p>
                    </div>
                </div>

                {/* Topics & Categories */}
                {summary.documentTopics.length > 0 && (
                    <div>
                        <p className="text-sm font-medium mb-2">Document Topics:</p>
                        <div className="flex flex-wrap gap-2">
                            {summary.documentTopics.map((topic, i) => (
                                <Badge key={i} variant="secondary">
                                    {topic}
                                </Badge>
                            ))}
                        </div>
                    </div>
                )}

                {summary.productCategories.length > 0 && (
                    <div>
                        <p className="text-sm font-medium mb-2">Available Products:</p>
                        <div className="flex flex-wrap gap-2">
                            {summary.productCategories.map((cat, i) => (
                                <Badge key={i} variant="outline" className="border-green-500/30 text-green-400">
                                    {cat}
                                </Badge>
                            ))}
                        </div>
                    </div>
                )}

                {/* Suggestions */}
                {summary.suggestions.length > 0 && (
                    <div className="bg-amber-500/10 border border-amber-500/20 rounded-lg p-3 space-y-2">
                        <div className="flex items-center gap-2 text-amber-400">
                            <Lightbulb className="h-4 w-4" />
                            <span className="text-sm font-medium">Suggestions</span>
                        </div>
                        <ul className="space-y-1">
                            {summary.suggestions.map((suggestion, i) => (
                                <li key={i} className="text-sm text-amber-200/80">
                                    • {suggestion}
                                </li>
                            ))}
                        </ul>
                    </div>
                )}
            </CardContent>
        </Card>
    );
}
