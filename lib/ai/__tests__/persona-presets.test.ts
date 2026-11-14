import { describe, it, expect } from 'vitest';
import { buildPersonaPresets } from '@/lib/ai/persona-presets';
import { buildSystemMessage } from '@/lib/ai/system-message';
import { GENERIC_BUSINESS_PROFILE, type BusinessProfile } from '@/lib/settings/business-profile';

// F10 (owner decision D8): the persona presets and the fallback persona are
// offered to every org, so they must speak as the org's own business profile
// and never carry Sailendra's identity, contacts or portfolio. Fake profile.

const SAILENDRA_IDENTITY =
    /sailendra|nindra|\bMJ\b|mang jajang|8195|kemenkeu|kementerian keuangan|pertamina|phincon|rakernas|sheraton|lembang|sentul|150rb/i;

const TENANT: BusinessProfile = {
    businessName: 'Cahaya Event',
    assistantName: 'Rina',
    specialties: 'Pernikahan dan Gathering Kantor',
    establishedYear: '2020',
    serviceAreas: 'Surabaya dan sekitarnya',
    handoffName: 'Budi',
    handoffPhone: '+62 811-0000-0000',
    businessEmail: 'halo@cahaya.test',
    website: 'cahaya.test',
};

const BARE: BusinessProfile = { ...GENERIC_BUSINESS_PROFILE };

describe('persona presets (F10)', () => {
    for (const meetings of [false, true]) {
        it(`carry no Sailendra identity and speak as the org (meetings: ${meetings})`, () => {
            for (const preset of Object.values(buildPersonaPresets(TENANT, { meetings }))) {
                expect(`${preset.name} ${preset.description} ${preset.content}`).not.toMatch(SAILENDRA_IDENTITY);
                expect(preset.content).toContain('**Rina**');
                expect(preset.content).toContain('**Cahaya Event**');
                expect(preset.content).toContain('Budi');
                expect(preset.content).toContain('+62 811-0000-0000');
                expect(preset.content).toContain('halo@cahaya.test');
            }
        });
    }

    it('are honest when asked if the customer talks to an AI (D4)', () => {
        for (const preset of Object.values(buildPersonaPresets(TENANT, { meetings: false }))) {
            expect(preset.content).toContain('jujur bahwa Anda asisten virtual (AI)');
            expect(preset.content).not.toMatch(/jangan pernah menyebut diri sebagai AI/i);
            expect(preset.content).not.toContain('TERLARANG');
        }
    });

    it('promise a meeting only to an org that can book one (D26)', () => {
        for (const preset of Object.values(buildPersonaPresets(TENANT, { meetings: false }))) {
            expect(preset.content).not.toMatch(/meeting/i);
        }
        const withMeetings = buildPersonaPresets(TENANT, { meetings: true });
        expect(withMeetings.default.content).toContain('online meeting dengan Budi');
    });

    it('render cleanly for an org without phone, email or founding year', () => {
        for (const preset of Object.values(buildPersonaPresets(BARE, { meetings: false }))) {
            expect(preset.content).not.toMatch(SAILENDRA_IDENTITY);
            expect(preset.content).not.toMatch(/\(\)|\*\*\*\*|undefined|null|sejak ,| sejak \./);
            expect(preset.content).not.toContain('email ****');
        }
        expect(buildPersonaPresets(BARE, { meetings: false }).default.content).toContain(
            'minta penawarannya dikirim tertulis'
        );
    });
});

describe('fallback persona (buildSystemMessage)', () => {
    it('carries no Sailendra identity', () => {
        for (const meetings of [false, true]) {
            expect(buildSystemMessage(TENANT, { meetings })).not.toMatch(SAILENDRA_IDENTITY);
            expect(buildSystemMessage(BARE, { meetings })).not.toMatch(SAILENDRA_IDENTITY);
        }
    });

    it('promises no meeting or calendar invite without the meeting tools (D26), and does by default', () => {
        for (const persona of [buildSystemMessage(TENANT), buildSystemMessage(TENANT, { meetings: false })]) {
            expect(persona).not.toMatch(/online meeting|SCHEDULING|undangan kalender akan dikirim|untuk undangan kalender/i);
            expect(persona).toContain('Budi akan menindaklanjuti');
            expect(persona).toContain('Jangan menjanjikan jadwal meeting atau undangan kalender.');
        }
    });

    it('keeps the meeting flow for the org that can book (the default org)', () => {
        const persona = buildSystemMessage(TENANT, { meetings: true });
        expect(persona).toContain('Menawarkan **online meeting** dengan tim sales');
        expect(persona).toContain('**SCHEDULING**');
        expect(persona).toContain('undangan kalender akan dikirim ke email');
    });
});
