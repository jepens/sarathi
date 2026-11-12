import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeFakeSupabase, type FakeSupabase } from './fakeSupabase';

// The Brief Acara Flow handler's lead stage (Fase 2 task 2.2a part 2): a new
// or unset lead moves to 'qualifying', through updateLeadStage with
// protectHumanStages (a stage the team set meanwhile is never overwritten);
// a stage that could not be read is not taken for unset, so it is left alone.
// Everything around it is stubbed. Fake ids and phones only.

const h = vi.hoisted(() => ({
    fake: null as unknown as FakeSupabase,
    stageError: null as unknown,
    stage: null as string | null,
    insertError: null as unknown,
}));

vi.mock('@/lib/whatsapp/client', () => ({ sendWhatsAppMessage: vi.fn(async () => ({ waMessageId: 'wamid.fake-out', raw: {} })) }));
vi.mock('@/lib/whatsapp/recipient', () => ({ resolveSendTarget: vi.fn(async () => '620000000000') }));
vi.mock('@/lib/whatsapp/history', () => ({ logSystemMessage: vi.fn(async () => ({ status: 'stored' })) }));
vi.mock('@/lib/utils/logger', () => ({ whatsappLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/ai/tools', () => ({ saveLeadInfo: vi.fn(async () => 'ok'), updateLeadStage: vi.fn(async () => 'ok') }));
vi.mock('@/lib/settings/business-profile', () => ({ getBusinessProfile: vi.fn(async () => null) }));

import { handleFlowReply, type NfmReplyPayload } from '@/lib/whatsapp/flow-response';
import { saveLeadInfo, updateLeadStage } from '@/lib/ai/tools';
import { logSystemMessage } from '@/lib/whatsapp/history';
import { whatsappLogger } from '@/lib/utils/logger';
import { sendWhatsAppMessage } from '@/lib/whatsapp/client';

const ORG = 'aaaaaaaa-0000-4000-8000-00000000000a';
const PHONE = '620000000000';

function submit(nfmReply: NfmReplyPayload = { response_json: JSON.stringify({ flow_token: 'token-palsu', jenis_acara: 'outing', nama_pic: 'Budi Palsu' }) }) {
    return handleFlowReply({
        supabase: h.fake.client,
        orgId: ORG,
        phoneNumberId: '100000000000001',
        accessToken: 'token-palsu',
        contactKey: PHONE,
        bsuid: null,
        waId: PHONE,
        inboundWamid: 'wamid.fake-flow-1',
        nfmReply,
    });
}

beforeEach(() => {
    vi.clearAllMocks();
    h.stageError = null;
    h.stage = null;
    h.insertError = null;
    h.fake = makeFakeSupabase({
        resolve: (c) => {
            if (c.table === 'whatsapp_messages' && c.op === 'insert' && h.insertError) {
                return { data: null, error: h.insertError, status: 500 };
            }
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

describe('handleFlowReply: its insert of the submission is the redelivery gate', () => {
    it('a failed insert (not a duplicate) stops before the lead, the stage, the note and the confirmation, and is reported', async () => {
        h.insertError = { code: '57014', message: 'canceling statement due to statement timeout' };
        expect(await submit()).toEqual({ status: 'gate_failed', error: h.insertError, httpStatus: 500 });
        expect(saveLeadInfo).not.toHaveBeenCalled();
        expect(updateLeadStage).not.toHaveBeenCalled();
        expect(logSystemMessage).not.toHaveBeenCalled();
        expect(sendWhatsAppMessage).not.toHaveBeenCalled();
    });

    it('a duplicate (23505) is reported as such, with nothing done again', async () => {
        h.insertError = { code: '23505', message: 'duplicate key value violates unique constraint' };
        expect(await submit()).toEqual({ status: 'duplicate' });
        expect(saveLeadInfo).not.toHaveBeenCalled();
        expect(sendWhatsAppMessage).not.toHaveBeenCalled();
    });

    it('a stored submission is followed up and reported as handled', async () => {
        expect(await submit()).toEqual({ status: 'handled' });
        expect(saveLeadInfo).toHaveBeenCalledTimes(1);
        expect(sendWhatsAppMessage).toHaveBeenCalledTimes(1);
    });

    it('a bug before the gate is thrown to the webhook (503, D24), with no submission row, lead or confirmation', async () => {
        h.fake = makeFakeSupabase({
            resolve: (c) => {
                if (c.table === 'whatsapp_chats' && c.op === 'upsert') throw new TypeError('x is not a function');
                return { data: null, error: null };
            },
        });
        await expect(submit()).rejects.toThrow(TypeError);
        expect(h.fake.calls.filter((c) => c.table === 'whatsapp_messages')).toEqual([]);
        expect(saveLeadInfo).not.toHaveBeenCalled();
        expect(sendWhatsAppMessage).not.toHaveBeenCalled();
    });

    it('a gate insert that throws (not an answer with an error) is still before the gate: thrown to the webhook, no lead or confirmation', async () => {
        h.fake = makeFakeSupabase({
            resolve: (c) => {
                if (c.table === 'whatsapp_messages' && c.op === 'insert') throw new TypeError('x is not a function');
                return { data: null, error: null };
            },
        });
        await expect(submit()).rejects.toThrow(TypeError);
        expect(saveLeadInfo).not.toHaveBeenCalled();
        expect(sendWhatsAppMessage).not.toHaveBeenCalled();
    });

    it('an error after the gate is only logged: the stored submission is handled (a 503 would make the resend a duplicate)', async () => {
        vi.mocked(saveLeadInfo).mockRejectedValueOnce(new TypeError('x is not a function'));
        expect(await submit()).toEqual({ status: 'handled' });
        expect(whatsappLogger.error).toHaveBeenCalledWith('flow-response: unexpected error handling nfm_reply', expect.any(TypeError));
    });
});

describe('handleFlowReply: the answers', () => {
    it('answers Meta escapes inside response_json (\\u0000, a lone \\udXXX) are cleaned after parsing, for the history row, the lead and the confirmation', async () => {
        // Escaped as a conforming serializer must (RFC 8259 §7): only
        // JSON.parse turns them into the code units Postgres refuses.
        const raw = '{"flow_token":"token-palsu","jenis_acara":"outing","nama_pic":"Budi\\u0000 Palsu\\ud83d"}';
        expect(await submit({ response_json: raw })).toEqual({ status: 'handled' });
        const gate = h.fake.calls.find((c) => c.table === 'whatsapp_messages' && c.op === 'insert');
        expect(JSON.stringify(gate?.payload)).toContain('Budi Palsu�');
        expect(JSON.stringify(gate?.payload)).not.toContain('\\u0000');
        expect(vi.mocked(saveLeadInfo).mock.calls[0][2]).toMatchObject({ name: 'Budi Palsu�' });
        expect(vi.mocked(sendWhatsAppMessage).mock.calls[0][1]).toContain('Terima kasih, Budi Palsu�!');
    });

    it.each([
        ['missing', {}],
        ['empty', { response_json: '' }],
        ['cut off', { response_json: '{"nama_pic":"Bud' }],
        ['an array', { response_json: '[1,2]' }],
        ['a string', { response_json: '"teks"' }],
    ])('response_json %s is reported unreadable, with nothing written or sent', async (_label, nfmReply) => {
        expect(await submit(nfmReply)).toEqual({ status: 'unreadable' });
        expect(h.fake.calls).toEqual([]);
        expect(saveLeadInfo).not.toHaveBeenCalled();
        expect(sendWhatsAppMessage).not.toHaveBeenCalled();
    });
});
