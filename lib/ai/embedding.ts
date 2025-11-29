import OpenAI from 'openai'
import { getOpenAIApiKey } from '@/lib/settings/app-settings'

export async function generateEmbedding(text: string) {
    const apiKey = await getOpenAIApiKey();

    const openai = new OpenAI({
        apiKey: apiKey,
    })

    const response = await openai.embeddings.create({
        model: 'text-embedding-3-small',
        input: text.replace(/\n/g, ' '),
    })

    return response.data[0].embedding
}
