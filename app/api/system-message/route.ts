import { NextResponse } from 'next/server';
import { buildSystemMessage } from '@/lib/ai/system-message';
import { getBusinessProfile } from '@/lib/settings/business-profile';
import { accessDeniedResponse, requireOrgContext } from '@/lib/settings/org-context';

export const dynamic = 'force-dynamic';

/**
 * GET /api/system-message
 * Get the active system message or a specific one by name
 */
export async function GET(request: Request) {
    try {
        const access = await requireOrgContext();
        if (!access.ok) return accessDeniedResponse(access);
        const { supabase, orgId } = access;

        const { searchParams } = new URL(request.url);
        const name = searchParams.get('name');

        let query = supabase.from('system_message').select('*').eq('org_id', orgId);

        if (name) {
            query = query.eq('name', name);
        } else {
            // Get active system message
            query = query.eq('is_active', true);
        }

        const { data, error } = await query.single();

        if (error) {
            // If no active message found, return a default built from this org's
            // business profile.
            if (error.code === 'PGRST116') {
                const content = buildSystemMessage(await getBusinessProfile(supabase, orgId));
                return NextResponse.json({
                    id: 'default',
                    name: 'Default System Message',
                    content,
                    is_active: true,
                    description: 'Default system message (not saved in DB)',
                    created_at: new Date().toISOString(),
                    updated_at: new Date().toISOString(),
                });
            }
            throw error;
        }

        return NextResponse.json(data);
    } catch (error) {
        console.error('Error fetching system message:', error);
        return NextResponse.json(
            { error: 'Failed to fetch system message' },
            { status: 500 }
        );
    }
}

/**
 * PUT /api/system-message
 * Update system message content or activate a different one
 */
export async function PUT(request: Request) {
    try {
        const access = await requireOrgContext();
        if (!access.ok) return accessDeniedResponse(access);
        const { supabase, orgId } = access;

        const body = await request.json();
        const { id, content, is_active } = body;

        // Validate ID
        if (!id) {
            return NextResponse.json(
                { error: 'Message ID is required' },
                { status: 400 }
            );
        }

        // Validate content if provided
        if (content !== undefined) {
            if (typeof content !== 'string') {
                return NextResponse.json(
                    { error: 'Content must be a string' },
                    { status: 400 }
                );
            }
            if (content.trim().length === 0) {
                return NextResponse.json(
                    { error: 'Content cannot be empty' },
                    { status: 400 }
                );
            }
            if (content.length > 50000) {
                return NextResponse.json(
                    { error: 'Content is too long (max 50,000 characters)' },
                    { status: 400 }
                );
            }
        }

        // Validate is_active if provided
        if (is_active !== undefined && typeof is_active !== 'boolean') {
            return NextResponse.json(
                { error: 'is_active must be a boolean' },
                { status: 400 }
            );
        }

        const updateData: {
            content?: string;
            is_active?: boolean;
            updated_at: string;
        } = {
            updated_at: new Date().toISOString(),
        };

        if (content !== undefined) {
            updateData.content = content.trim();
        }

        if (is_active !== undefined) {
            updateData.is_active = is_active;
        }

        const { data, error } = await supabase
            .from('system_message')
            .update(updateData)
            .eq('org_id', orgId)
            .eq('id', id)
            .select()
            .single();

        if (error) throw error;

        return NextResponse.json(data);
    } catch (error) {
        console.error('Error updating system message:', error);
        return NextResponse.json(
            { error: 'Failed to update system message' },
            { status: 500 }
        );
    }
}

/**
 * POST /api/system-message
 * Create a new system message configuration
 */
export async function POST(request: Request) {
    try {
        const access = await requireOrgContext();
        if (!access.ok) return accessDeniedResponse(access);
        const { supabase, orgId } = access;

        const body = await request.json();
        const { name, content, description, is_active = false } = body;

        // Validate required fields
        if (!name || !content) {
            return NextResponse.json(
                { error: 'Name and content are required' },
                { status: 400 }
            );
        }

        // Validate name format
        if (typeof name !== 'string' || !/^[a-z0-9_]+$/.test(name)) {
            return NextResponse.json(
                { error: 'Name must contain only lowercase letters, numbers, and underscores' },
                { status: 400 }
            );
        }

        // Validate content
        if (typeof content !== 'string') {
            return NextResponse.json(
                { error: 'Content must be a string' },
                { status: 400 }
            );
        }

        if (content.trim().length === 0) {
            return NextResponse.json(
                { error: 'Content cannot be empty' },
                { status: 400 }
            );
        }

        if (content.length > 50000) {
            return NextResponse.json(
                { error: 'Content is too long (max 50,000 characters)' },
                { status: 400 }
            );
        }

        // Validate is_active
        if (typeof is_active !== 'boolean') {
            return NextResponse.json(
                { error: 'is_active must be a boolean' },
                { status: 400 }
            );
        }

        // system_message.org_id is NOT NULL with an is_org_member with_check —
        // set it explicitly (orgId above) so a non-Sailendra tenant's persona
        // isn't rejected (and isn't mis-attributed via the column DEFAULT).

        const { data, error } = await supabase
            .from('system_message')
            .insert([
                {
                    org_id: orgId,
                    name,
                    content: content.trim(),
                    description: description || null,
                    is_active,
                },
            ])
            .select()
            .single();

        if (error) {
            // Handle unique constraint violation
            if (error.code === '23505') {
                return NextResponse.json(
                    { error: `System message with name '${name}' already exists` },
                    { status: 409 }
                );
            }
            throw error;
        }

        return NextResponse.json(data, { status: 201 });
    } catch (error) {
        console.error('Error creating system message:', error);
        return NextResponse.json(
            { error: 'Failed to create system message' },
            { status: 500 }
        );
    }
}
