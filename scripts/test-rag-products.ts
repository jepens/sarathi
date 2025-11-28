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

        const response = await generateRAGResponse(query);

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
