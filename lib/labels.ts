// Pure helpers + colour palette for the Labels ("list" ala WhatsApp Business)
// feature. Kept free of React / Supabase so it unit-tests without a DOM and is
// shared by the settings editor, the chat header picker, and the chat list.

export interface Label {
    id: string;
    name: string;
    color: string; // one of LABEL_COLOR_KEYS; unknown values fall back to slate
}

// A chat's label assignment as stored in `chat_labels`.
export interface ChatLabel {
    phone_number: string;
    label_id: string;
}

export interface LabelColor {
    key: string;
    /** Indonesian display name, shown in the colour picker (title / aria). */
    name: string;
    /** Solid dot, e.g. the compact marker in the chat list. */
    dot: string;
    /** Full chip classes (bg + text + border) — light AND dark. */
    chip: string;
    /** Solid swatch for the colour-picker buttons. */
    swatch: string;
}

// The palette. Every className here is a COMPLETE literal string so Tailwind's
// JIT scanner emits it (dynamically-built class names like `bg-${c}-100` would
// NOT be generated). Keep these keys in sync with the CHECK constraint in
// supabase/migrations/0053_labels.sql.
export const LABEL_COLORS: readonly LabelColor[] = [
    {
        key: 'slate',
        name: 'Abu-abu',
        dot: 'bg-slate-500',
        swatch: 'bg-slate-500',
        chip: 'bg-slate-100 text-slate-700 border-slate-300 dark:bg-slate-500/15 dark:text-slate-300 dark:border-slate-500/30',
    },
    {
        key: 'red',
        name: 'Merah',
        dot: 'bg-red-500',
        swatch: 'bg-red-500',
        chip: 'bg-red-100 text-red-700 border-red-300 dark:bg-red-500/15 dark:text-red-300 dark:border-red-500/30',
    },
    {
        key: 'orange',
        name: 'Oranye',
        dot: 'bg-orange-500',
        swatch: 'bg-orange-500',
        chip: 'bg-orange-100 text-orange-700 border-orange-300 dark:bg-orange-500/15 dark:text-orange-300 dark:border-orange-500/30',
    },
    {
        key: 'amber',
        name: 'Amber',
        dot: 'bg-amber-500',
        swatch: 'bg-amber-500',
        chip: 'bg-amber-100 text-amber-800 border-amber-300 dark:bg-amber-500/15 dark:text-amber-300 dark:border-amber-500/30',
    },
    {
        key: 'yellow',
        name: 'Kuning',
        dot: 'bg-yellow-500',
        swatch: 'bg-yellow-500',
        chip: 'bg-yellow-100 text-yellow-800 border-yellow-300 dark:bg-yellow-500/15 dark:text-yellow-300 dark:border-yellow-500/30',
    },
    {
        key: 'green',
        name: 'Hijau',
        dot: 'bg-green-500',
        swatch: 'bg-green-500',
        chip: 'bg-green-100 text-green-700 border-green-300 dark:bg-green-500/15 dark:text-green-300 dark:border-green-500/30',
    },
    {
        key: 'emerald',
        name: 'Zamrud',
        dot: 'bg-emerald-500',
        swatch: 'bg-emerald-500',
        chip: 'bg-emerald-100 text-emerald-700 border-emerald-300 dark:bg-emerald-500/15 dark:text-emerald-300 dark:border-emerald-500/30',
    },
    {
        key: 'teal',
        name: 'Tosca',
        dot: 'bg-teal-500',
        swatch: 'bg-teal-500',
        chip: 'bg-teal-100 text-teal-700 border-teal-300 dark:bg-teal-500/15 dark:text-teal-300 dark:border-teal-500/30',
    },
    {
        key: 'sky',
        name: 'Biru langit',
        dot: 'bg-sky-500',
        swatch: 'bg-sky-500',
        chip: 'bg-sky-100 text-sky-700 border-sky-300 dark:bg-sky-500/15 dark:text-sky-300 dark:border-sky-500/30',
    },
    {
        key: 'blue',
        name: 'Biru',
        dot: 'bg-blue-500',
        swatch: 'bg-blue-500',
        chip: 'bg-blue-100 text-blue-700 border-blue-300 dark:bg-blue-500/15 dark:text-blue-300 dark:border-blue-500/30',
    },
    {
        key: 'violet',
        name: 'Ungu',
        dot: 'bg-violet-500',
        swatch: 'bg-violet-500',
        chip: 'bg-violet-100 text-violet-700 border-violet-300 dark:bg-violet-500/15 dark:text-violet-300 dark:border-violet-500/30',
    },
    {
        key: 'pink',
        name: 'Merah muda',
        dot: 'bg-pink-500',
        swatch: 'bg-pink-500',
        chip: 'bg-pink-100 text-pink-700 border-pink-300 dark:bg-pink-500/15 dark:text-pink-300 dark:border-pink-500/30',
    },
] as const;

export const LABEL_COLOR_KEYS: readonly string[] = LABEL_COLORS.map((c) => c.key);

export const DEFAULT_LABEL_COLOR = 'slate';

const COLOR_BY_KEY = new Map<string, LabelColor>(LABEL_COLORS.map((c) => [c.key, c]));

// Resolve a stored colour key to its palette entry. Falls back to slate so a
// stale/unknown key (e.g. removed from the palette later) never renders unstyled.
export function labelColor(key: string | null | undefined): LabelColor {
    return (key && COLOR_BY_KEY.get(key)) || COLOR_BY_KEY.get(DEFAULT_LABEL_COLOR)!;
}

export const MAX_LABEL_NAME = 30;

// Trim, collapse inner whitespace, and cap length. Labels are short free text
// (no slash-shortcut rules like quick replies) but must not be blank or huge.
export function normalizeLabelName(raw: string): string {
    return raw.replace(/\s+/g, ' ').trim().slice(0, MAX_LABEL_NAME);
}

// Alphabetical (case-insensitive, locale-aware) ordering for the editor list and
// the picker so labels don't jump around by created_at. Returns a new array.
export function sortLabels<T extends { name: string }>(labels: readonly T[]): T[] {
    return [...labels].sort((a, b) => a.name.localeCompare(b.name, 'id', { sensitivity: 'base' }));
}
