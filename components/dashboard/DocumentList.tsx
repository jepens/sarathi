import { useState } from 'react';
import { FileText, Trash2, Loader2, AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";

interface Document {
    id: string;
    file_name: string;
    file_type: string;
    created_at: string;
    chunk_count: number;
}

interface DocumentListProps {
    documents: Document[];
    onDocumentDeleted: () => void;
}

export function DocumentList({ documents, onDocumentDeleted }: DocumentListProps) {
    const [deletingId, setDeletingId] = useState<string | null>(null);
    const [docToDelete, setDocToDelete] = useState<Document | null>(null);

    const handleDeleteClick = (doc: Document) => {
        setDocToDelete(doc);
    };

    const confirmDelete = async () => {
        if (!docToDelete) return;

        const { file_name, id } = docToDelete;
        setDeletingId(id);
        setDocToDelete(null); // Close dialog immediately

        try {
            const response = await fetch(`/api/documents?fileName=${encodeURIComponent(file_name)}`, {
                method: 'DELETE',
            });

            if (!response.ok) {
                throw new Error('Failed to delete document');
            }

            toast.success('Document deleted successfully');
            onDocumentDeleted();
        } catch (error) {
            console.error('Error deleting document:', error);
            toast.error('Failed to delete document');
        } finally {
            setDeletingId(null);
        }
    };

    const formatDate = (dateString: string) => {
        const date = new Date(dateString);
        return new Intl.DateTimeFormat('id-ID', {
            day: 'numeric',
            month: 'short',
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
        }).format(date);
    };

    const getFileIcon = () => {
        return <FileText className="h-5 w-5 text-muted-foreground" />;
    };

    if (documents.length === 0) {
        return (
            <div className="rounded-lg border border-white/10 bg-black/20 p-8 text-center">
                <FileText className="mx-auto h-12 w-12 text-muted-foreground/50" />
                <p className="mt-4 text-sm text-muted-foreground">
                    No documents uploaded yet. Upload your first document to get started.
                </p>
            </div>
        );
    }

    return (
        <>
            <div className="space-y-2">
                {documents.map((doc) => (
                    <div
                        key={doc.id}
                        className="group flex items-center justify-between rounded-lg border border-white/10 bg-black/20 p-4 transition-colors hover:bg-black/30"
                    >
                        <div className="flex items-center gap-3">
                            {getFileIcon()}
                            <div>
                                <p className="font-medium text-sm">{doc.file_name}</p>
                                <p className="text-xs text-muted-foreground">
                                    {doc.chunk_count} chunk{doc.chunk_count > 1 ? 's' : ''} • {formatDate(doc.created_at)}
                                </p>
                            </div>
                        </div>
                        <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleDeleteClick(doc)}
                            disabled={deletingId === doc.id}
                            className="text-muted-foreground hover:text-destructive transition-colors"
                        >
                            {deletingId === doc.id ? (
                                <Loader2 className="h-4 w-4 animate-spin" />
                            ) : (
                                <Trash2 className="h-4 w-4" />
                            )}
                        </Button>
                    </div>
                ))}
            </div>

            <Dialog open={!!docToDelete} onOpenChange={(open) => !open && setDocToDelete(null)}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle className="flex items-center gap-2 text-destructive">
                            <AlertTriangle className="h-5 w-5" />
                            Delete Document
                        </DialogTitle>
                        <DialogDescription>
                            Are you sure you want to delete <strong>{docToDelete?.file_name}</strong>?
                            <br />
                            This action cannot be undone and will remove all associated knowledge chunks.
                        </DialogDescription>
                    </DialogHeader>
                    <DialogFooter>
                        <Button variant="outline" onClick={() => setDocToDelete(null)}>
                            Cancel
                        </Button>
                        <Button variant="destructive" onClick={confirmDelete}>
                            Delete
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </>
    );
}
