import { NextResponse } from 'next/server';
import { generateRAGResponse, ChatMessage } from '@/lib/ai/rag';
import { createClient } from '@/lib/supabase/server';

/**
 * Streaming chat endpoint — emits NDJSON (one JSON object per line).
 *
 * Event shapes:
 *   { "type": "text",    "delta": "..."          }   token from the model
 *   { "type": "tool",    "name": "...", "phase": "executing" | "done", "ok"?: boolean }
 *   { "type": "sources", "sources": ["..."]      }   citations, emitted once at end
 *   { "type": "done"                              }   final terminator
 *   { "type": "error",   "error": "..."          }   if something failed mid-stream
 *
 * Why NDJSON instead of SSE? It avoids the `data:` framing and works with a
 * plain `fetch().body.getReader()` + line splitting on the client. Order is
 * preserved and back-pressure works naturally via the underlying stream.
 */
export async function POST(request: Request) {
    const supabase = await createClient();
    const {
        data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    let parsed: { message?: string; history?: ChatMessage[] };
    try {
        parsed = await request.json();
    } catch {
        return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    const message = parsed.message;
    const history = (parsed.history ?? []) as ChatMessage[];

    if (!message || typeof message !== 'string') {
        return NextResponse.json({ error: 'Message is required' }, { status: 400 });
    }

    const encoder = new TextEncoder();

    const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
            const writeEvent = (event: Record<string, unknown>) => {
                try {
                    controller.enqueue(encoder.encode(JSON.stringify(event) + '\n'));
                } catch {
                    // Controller may be closed if the client disconnected; ignore.
                }
            };

            try {
                const response = await generateRAGResponse(message, history, undefined, {
                    onTextChunk: (delta) => writeEvent({ type: 'text', delta }),
                    onToolStatus: (info) => writeEvent({ type: 'tool', ...info }),
                    // Cancels upstream OpenAI calls if the client closes the
                    // connection mid-stream so we don't keep paying for tokens.
                    signal: request.signal,
                });

                if (response.sources && response.sources.length > 0) {
                    writeEvent({ type: 'sources', sources: response.sources });
                }
                writeEvent({ type: 'done' });
            } catch (error) {
                // An AbortError from the client disconnect is expected; don't log it as an error.
                if (request.signal.aborted) {
                    console.info('Streaming chat aborted by client');
                } else {
                    console.error('Streaming chat error:', error);
                    const errorMessage =
                        error instanceof Error ? error.message : 'Internal server error';
                    writeEvent({ type: 'error', error: errorMessage });
                }
            } finally {
                try {
                    controller.close();
                } catch {
                    // Already closed.
                }
            }
        },
    });

    return new Response(stream, {
        headers: {
            'Content-Type': 'application/x-ndjson; charset=utf-8',
            'Cache-Control': 'no-store, no-transform',
            'X-Content-Type-Options': 'nosniff',
        },
    });
}
