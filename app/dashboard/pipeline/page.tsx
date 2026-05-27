import { PipelineBoard } from './components/PipelineBoard';

export default function PipelinePage() {
    return (
        <div className="space-y-6 h-full flex flex-col">
            <div>
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
