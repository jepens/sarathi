import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env.local') });

import { searchDestination, calculateShippingCost } from '../lib/shipping/komerce';

async function test() {
    console.log('Testing Shipping Service...');

    // Test Search
    console.log('\nSearching for "Jakarta"...');
    const destinations = await searchDestination('Jakarta');
    console.log('Destinations found:', destinations.length);
    if (destinations.length > 0) {
        console.log('First result:', destinations[0]);

        // Test Cost
        console.log('\nCalculating cost to first result...');
        const costs = await calculateShippingCost(destinations[0].id);
        console.log('Costs:', costs);
    } else {
        console.log('No destinations found. Check API Key or Endpoint.');
    }
}

test();
