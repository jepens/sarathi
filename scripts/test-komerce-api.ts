import fetch from 'node-fetch';

const API_KEY = '0KutCiCz396b710cc2de0138th7k3kDe';
const BASE_URL = 'https://rajaongkir.komerce.id/api/v1';

async function testAPI() {
    console.log('Testing RajaOngkir Shipping Cost API...');
    console.log(`Base URL: ${BASE_URL}\n`);

    const headers = {
        'key': API_KEY
    };

    // Test POST /calculate/domestic-cost with form-urlencoded
    console.log('--- Testing POST /calculate/domestic-cost ---\n');

    try {
        const url = `${BASE_URL}/calculate/domestic-cost`;
        console.log(`URL: ${url}`);

        // Using URLSearchParams for form-urlencoded
        const params = new URLSearchParams({
            origin: '4117',
            destination: '4108',
            weight: '1000',
            courier: 'jne'
        });

        console.log('Payload (form-urlencoded):', params.toString());

        const response = await fetch(url, {
            method: 'POST',
            headers: {
                ...headers,
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: params.toString()
        });

        console.log(`Status: ${response.status}`);

        if (response.ok) {
            const data = await response.json();
            console.log('✓ SUCCESS!\n');
            console.log(JSON.stringify(data, null, 2));
        } else {
            const errorText = await response.text();
            console.log('✗ Failed:');
            console.log(errorText);
        }
    } catch (e) {
        const error = e as Error;
        console.log('✗ Error:', error.message);
    }
}

testAPI();
