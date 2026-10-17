'use client';

import { useCallback } from 'react';
import { chatMediaHref } from '@/lib/storage/chat-media';
import { keepStreamFresh } from '@/lib/storage/chat-media-player';

interface ChatMediaPlayerProps {
    messageId: string;
    kind: 'audio' | 'video';
    className?: string;
}

// A voice note or video in the chat. Its source is /api/chat-media/<id>, a 302
// to a signed URL; keepStreamFresh renews that source before the token runs
// out, so play and seek still work long after the chat was opened.
export function ChatMediaPlayer({ messageId, kind, className }: ChatMediaPlayerProps) {
    const href = chatMediaHref(messageId);
    const watch = useCallback(
        (el: HTMLMediaElement | null) => (el ? keepStreamFresh(el, href) : undefined),
        [href]
    );
    return kind === 'audio' ? (
        <audio ref={watch} controls preload="none" src={href} className={className} />
    ) : (
        <video ref={watch} controls preload="metadata" src={href} className={className} />
    );
}
