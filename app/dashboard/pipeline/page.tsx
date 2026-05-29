import { PipelineBoard } from './components/PipelineBoard';

export default function PipelinePage() {
    return (
        // Bounded viewport height (main has p-8 → 4rem vertical padding) so the
        // board's flex chain resolves: columns scroll vertically inside their own
        // height and the horizontal scrollbar sits at the bottom of the viewport
        // instead of being pushed off-screen by the tallest column.
        <div className="space-y-6 flex flex-col h-[calc(100vh-4rem)]">
            <div className="flex-shrink-0">
                <h1 className="text-2xl font-bold tracking-tight">Sales Pipeline</h1>
                <p className="text-muted-foreground">
                    Drag lead ke kolom lain untuk update stage-nya. Stage tersimpan otomatis.
                </p>
            </div>
            <div className="flex-1 min-h-0">
                <PipelineBoard />
            </div>
        </div>
    );
}
