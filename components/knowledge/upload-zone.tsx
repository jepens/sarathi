"use client"

import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { createClient } from "@/lib/supabase/client"
import { cn } from "@/lib/utils"
import { Loader2, UploadCloud } from "lucide-react"
import { useState, useRef } from "react"
import { toast } from "sonner"
import { useCurrentOrgId } from "@/components/current-org-provider"

interface UploadZoneProps {
    onUploadComplete?: () => void;
}

export function UploadZone({ onUploadComplete }: UploadZoneProps = {}) {
    const [isDragging, setIsDragging] = useState(false)
    const [isUploading, setIsUploading] = useState(false)
    const fileInputRef = useRef<HTMLInputElement>(null)
    // The org resolved server-side (dashboard layout). /api/ingest only accepts
    // paths under this org's "<org_id>/" folder, so client and server must agree.
    const orgId = useCurrentOrgId()

    const handleDragOver = (e: React.DragEvent) => {
        e.preventDefault()
        setIsDragging(true)
    }

    const handleDragLeave = () => {
        setIsDragging(false)
    }

    const processFile = async (file: File) => {
        // An empty file yields no text, so no KB entry: never upload it.
        if (file.size === 0) {
            toast.error("File kosong — tidak ada yang bisa diunggah.")
            return
        }
        setIsUploading(true)
        // One evolving toast across the two phases (upload → embed) instead of
        // separate info/success toasts.
        const toastId = toast.loading("Mengunggah file…")
        const supabase = createClient()

        try {
            // KB files land under "<org_id>/..." — the documents-bucket RLS
            // policy authorises only members of that org.
            if (!orgId) {
                throw new Error('Tidak menemukan organisasi untuk akun ini.')
            }

            // 1. Upload to Supabase Storage (org-scoped path)
            const filePath = `${orgId}/${Date.now()}_${file.name}`
            const { error: uploadError } = await supabase.storage
                .from('documents')
                .upload(filePath, file)

            if (uploadError) throw uploadError

            toast.loading("Memproses embedding AI…", { id: toastId })

            // An upload without a documents row is never listed, so nobody
            // could delete it later (tracker 3.9). /api/ingest removes it on
            // its own failures; here only when the request never reached it
            // (network error, or the proxy / app answering 502 / 503). Not on a
            // timeout: the server may still be storing the rows.
            const discardUpload = async () => {
                try {
                    await supabase.storage.from('documents').remove([filePath])
                } catch {
                    // best-effort
                }
            }

            // 2. Trigger Ingestion API
            let response: Response
            try {
                response = await fetch('/api/ingest', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ filePath, fileType: file.type }),
                })
            } catch {
                await discardUpload()
                throw new Error('Gagal menghubungi server. Silakan coba lagi.')
            }

            if (!response.ok) {
                if (response.status === 502 || response.status === 503) await discardUpload()
                // A 4xx reason is meant for the user (e.g. an empty or unreadable
                // file); anything else gets a generic message.
                const body = await response.json().catch(() => null) as { error?: unknown } | null
                const reason = response.status < 500 && typeof body?.error === 'string' ? body.error : null
                throw new Error(reason ?? 'Gagal memproses dokumen. Silakan coba lagi.')
            }

            const data = await response.json()
            toast.success(`Berhasil — ${data.chunks} potongan diproses.`, { id: toastId })

            // Notify parent to refresh the document list
            onUploadComplete?.()
        } catch (error) {
            console.error(error)
            const errorMessage = error instanceof Error ? error.message : "Terjadi kesalahan"
            toast.error(errorMessage, { id: toastId })
        } finally {
            setIsUploading(false)
        }
    }

    const handleDrop = (e: React.DragEvent) => {
        e.preventDefault()
        setIsDragging(false)

        const file = e.dataTransfer.files[0]
        if (file) processFile(file)
    }

    const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0]
        if (file) processFile(file)
    }

    return (
        <Card
            className={cn(
                "border-2 border-dashed transition-colors duration-200 cursor-pointer",
                isDragging ? "border-primary bg-primary/5" : "border-muted-foreground/25 hover:border-primary/50"
            )}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            onClick={() => fileInputRef.current?.click()}
        >
            <CardContent className="flex flex-col items-center justify-center py-10 space-y-4 text-center">
                <div className="p-4 rounded-full bg-muted">
                    {isUploading ? (
                        <Loader2 className="w-8 h-8 text-muted-foreground animate-spin" />
                    ) : (
                        <UploadCloud className="w-8 h-8 text-muted-foreground" />
                    )}
                </div>
                <div className="space-y-1">
                    <h3 className="font-semibold text-lg">
                        {isUploading ? "Processing..." : "Upload Knowledge"}
                    </h3>
                    <p className="text-sm text-muted-foreground">
                        Drag & drop PDF, TXT, or MD files here
                    </p>
                </div>
                <Button variant="outline" disabled={isUploading}>
                    Select Files
                </Button>
                <input
                    type="file"
                    className="hidden"
                    ref={fileInputRef}
                    onChange={handleFileSelect}
                    accept=".txt,.md,.pdf"
                />
            </CardContent>
        </Card>
    )
}
