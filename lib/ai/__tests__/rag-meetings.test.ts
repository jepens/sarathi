import { describe, it, expect, vi, beforeEach } from 'vitest';

// Online meetings (Zoom room, invite email, sales WhatsApp) run on Sailendra's
// own accounts, so the AI offers the meeting tools, and their instructions,
// to the default org only (owner decisions D8, D26). Every other org gets
// neither, so its bot can never book through Sailendra. Fake ids only.

const DEFAULT_ORG = 'aaaaaaaa-0000-4000-8000-00000000000a';
const OTHER_ORG = 'bbbbbbbb-0000-4000-8000-00000000000b';

const h = vi.hoisted(() => ({ create: vi.fn(), persona: vi.fn(async () => 'PERSONA') }));

vi.mock('openai', () => ({
    default: class {
        embeddings = { create: async () => ({ data: [{ embedding: [0.1] }] }) };
        chat = { completions: { create: h.create } };
    },
}));
vi.mock('@/lib/supabase/service', () => ({
    createServiceOrServerClient: async () => ({ rpc: async () => ({ data: [], error: null }) }),
}));
vi.mock('@/lib/settings/org-context', () => ({ getDefaultOrgId: async () => 'aaaaaaaa-0000-4000-8000-00000000000a' }));
vi.mock('@/lib/settings/business-profile', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/lib/settings/business-profile')>();
    return { ...actual, getBusinessProfile: async () => ({ ...actual.GENERIC_BUSINESS_PROFILE }) };
});
vi.mock('@/lib/ai/system-message', () => ({ getActiveSystemMessage: h.persona }));
vi.mock('@/lib/settings/app-settings', () => ({ getOpenAIApiKey: async () => 'sk-palsu' }));

import { generateRAGResponse } from '@/lib/ai/rag';

type Call = { tools: Array<{ function: { name: string } }>; messages: Array<{ role: string; content: string }> };

async function firstCall(orgId: string): Promise<{ tools: string[]; system: string }> {
    await generateRAGResponse('halo, mau tanya paket', [], '6281112223', { orgId });
    const params = h.create.mock.calls[0][0] as Call;
    return {
        tools: params.tools.map((t) => t.function.name),
        system: params.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n'),
    };
}

beforeEach(() => {
    h.create.mockReset().mockResolvedValue({ choices: [{ message: { role: 'assistant', content: 'Halo kak' } }] });
    h.persona.mockClear();
});

describe('meeting tools follow the org (D8, D26)', () => {
    it('the default org (Sailendra) gets the meeting tools and their instructions', async () => {
        const { tools, system } = await firstCall(DEFAULT_ORG);
        expect(tools).toEqual(expect.arrayContaining(['check_meeting_availability', 'schedule_meeting']));
        expect(system).toContain('check_meeting_availability');
        expect(system).toContain('schedule_meeting');
        // Its fallback persona keeps the meeting flow (F10).
        expect(h.persona).toHaveBeenCalledWith(expect.anything(), DEFAULT_ORG, { meetings: true });
    });

    it('any other org gets neither the tools nor a word about them', async () => {
        const { tools, system } = await firstCall(OTHER_ORG);
        expect(tools).not.toContain('check_meeting_availability');
        expect(tools).not.toContain('schedule_meeting');
        // The rest of the toolset is unchanged.
        expect(tools).toEqual(expect.arrayContaining(['save_lead_info', 'handoff_to_human', 'create_order']));
        expect(system).not.toContain('check_meeting_availability');
        expect(system).not.toContain('schedule_meeting');
        // Its fallback persona promises no meeting or calendar invite (F10).
        expect(h.persona).toHaveBeenCalledWith(expect.anything(), OTHER_ORG, { meetings: false });
    });
});
