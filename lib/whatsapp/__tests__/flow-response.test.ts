import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeFakeSupabase, type FakeSupabase } from './fakeSupabase';

// The Brief Acara Flow handler's lead stage (Fase 2 task 2.2a part 2): a new
// or unset lead moves to 'qualifying', through updateLeadStage with
// protectHumanStages (a stage the team set meanwhile is never overwritten);
// a stage that could not be read is not taken for unset, so it is left alone.
// Everything around it is stubbed. Fake ids and phones only.

const h = vi.hoisted(() => ({ fake: null as unknown as FakeSupabase, stageError: null as unknown, stage: null as string | null }));

vi.mock('@/lib/whatsapp/client', () => ({ sendWhatsAppMessage: vi.fn(async () => ({ waMessageId: 'wamid.fake-out', raw: {} })) }));
vi.mock('@/lib/whatsapp/recipient', () => ({ resolveSendTarget: vi.fn(async () => '620000000000') }));
vi.mock('@/lib/whatsapp/history', () => ({ logSystemMessage: vi.fn(async () => ({ status: 'stored' })) }));
vi.mock('@/lib/utils/logger', () => ({ whatsappLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/ai/tools', () => ({ saveLeadInfo: vi.fn(async () => 'ok'), updateLeadStage: vi.fn(async () => 'ok') }));
vi.mock('@/lib/settings/business-profile', () => ({ getBusinessProfile: vi.fn(async () => null) }));

import { handleFlowReply } from '@/lib/whatsapp/flow-response';
import { updateLeadStage } from '@/lib/ai/tools';
import { whatsappLogger } from '@/lib/utils/logger';
import { sendWhatsAppMessage } from '@/lib/whatsapp/client';

const ORG = 'aaaaaaaa-0000-4000-8000-00000000000a';
const PHONE = '620000000000';

function submit() {
    return handleFlowReply({
        supabase: h.fake.client,
        orgId: ORG,
        phoneNumberId: '100000000000001',
        accessToken: 'token-palsu',
        contactKey: PHONE,
        bsuid: null,
        waId: PHONE,
        inboundWamid: 'wamid.fake-flow-1',
        nfmReply: { response_json: JSON.stringify({ flow_token: 'token-palsu', jenis_acara: 'outing', nama_pic: 'Budi Palsu' }) },
    });
}

beforeEach(() => {
    vi.clearAllMocks();
    h.stageError = null;
    h.stage = null;
    h.fake = makeFakeSupabase({
        resolve: (c) => {
            if (c.table === 'whatsapp_chats' && c.op === 'select') {
                return h.stageError ? { data: null, error: h.stageError } : { data: { lead_stage: h.stage }, error: null };
            }
            return { data: null, error: null };
        },
    });
});

describe('handleFlowReply: the lead stage', () => {
    it.each([null, 'new'])("moves a lead at %s to 'qualifying', refusing a stage the team set meanwhile", async (stage) => {
        h.stage = stage;
        await submit();
        expect(updateLeadStage).toHaveBeenCalledWith(ORG, PHONE, 'qualifying', 'Mengisi form Brief Acara (WhatsApp Flow)', {
            protectHumanStages: true,
        });
    });

    it.each(['qualifying', 'quoted', 'booked', 'won', 'lost'])('never moves a lead at %s', async (stage) => {
        h.stage = stage;
        await submit();
        expect(updateLeadStage).not.toHaveBeenCalled();
    });

    it('leaves the stage alone when it cannot be read (not taken for unset), and still confirms', async () => {
        h.stageError = { code: '57014', message: 'canceling statement due to statement timeout' };
        await submit();
        expect(updateLeadStage).not.toHaveBeenCalled();
        expect(whatsappLogger.error).toHaveBeenCalledWith('flow-response: lead stage could not be read — stage left unchanged', h.stageError);
        expect(sendWhatsAppMessage).toHaveBeenCalledTimes(1);
    });
});
