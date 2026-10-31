import { generateRAGResponse } from '../lib/ai/rag';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

// Load environment variables
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env.local') });

async function testRAG() {
    console.log('Testing RAG with Product Search...');

    try {
        // Test query that should trigger product search
        const query = "Apa saja produk yang dijual?";
        console.log(`Query: "${query}"`);

        // The org whose Knowledge Base and products to search (no default).
        const orgId = process.argv[2] || process.env.RAG_TEST_ORG_ID;
        if (!orgId) throw new Error('Usage: test-rag-products <org-id> (or RAG_TEST_ORG_ID)');
        const response = await generateRAGResponse(query, [], undefined, { orgId });

        console.log('\nResponse:');
        console.log(response.message);

        console.log('\nSources:');
        console.log(response.sources);

    } catch (error: any) {
        console.error('Test failed:', error.message);
        console.error('Stack:', error.stack);
        if (error.cause) console.error('Cause:', error.cause);
    }
}

testRAG();
