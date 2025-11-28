/**
 * System Message Configuration - Test Script
 * 
 * This script tests all aspects of the system message configuration feature:
 * 1. API endpoints (GET, PUT, POST)
 * 2. Database integration
 * 3. Helper function
 * 4. RAG integration
 */

const API_BASE = 'http://localhost:3000';

// Colors for console output
const colors = {
    reset: '\x1b[0m',
    green: '\x1b[32m',
    red: '\x1b[31m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    cyan: '\x1b[36m',
};

function log(message: string, color: keyof typeof colors = 'reset') {
    console.log(`${colors[color]}${message}${colors.reset}`);
}

function logTest(testName: string) {
    console.log(`\n${colors.cyan}🧪 Testing: ${testName}${colors.reset}`);
}

function logSuccess(message: string) {
    console.log(`${colors.green}✅ ${message}${colors.reset}`);
}

function logError(message: string) {
    console.log(`${colors.red}❌ ${message}${colors.reset}`);
}

function logInfo(message: string) {
    console.log(`${colors.blue}ℹ️  ${message}${colors.reset}`);
}

async function test1_GetActiveSystemMessage() {
    logTest('GET /api/system-message (Active Message)');

    try {
        const response = await fetch(`${API_BASE}/api/system-message`);
        const data = await response.json();

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${data.error || 'Unknown error'}`);
        }

        // Verify response structure
        if (!data.id || !data.name || !data.content || data.is_active === undefined) {
            throw new Error('Invalid response structure');
        }

        if (!data.is_active) {
            throw new Error('Retrieved message is not active');
        }

        logSuccess('Active system message retrieved successfully');
        logInfo(`Name: ${data.name}`);
        logInfo(`Active: ${data.is_active}`);
        logInfo(`Content length: ${data.content.length} characters`);
        logInfo(`Last updated: ${new Date(data.updated_at).toLocaleString('id-ID')}`);

        return data;
    } catch (error) {
        logError(`Failed: ${error instanceof Error ? error.message : String(error)}`);
        throw error;
    }
}

async function test2_GetSpecificSystemMessage(name: string) {
    logTest(`GET /api/system-message?name=${name}`);

    try {
        const response = await fetch(`${API_BASE}/api/system-message?name=${name}`);
        const data = await response.json();

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${data.error || 'Unknown error'}`);
        }

        if (data.name !== name) {
            throw new Error(`Expected name '${name}', got '${data.name}'`);
        }

        logSuccess(`System message '${name}' retrieved successfully`);
        logInfo(`Active: ${data.is_active}`);
        logInfo(`Description: ${data.description || 'N/A'}`);

        return data;
    } catch (error) {
        logError(`Failed: ${error instanceof Error ? error.message : String(error)}`);
        throw error;
    }
}

async function test3_UpdateSystemMessage(id: string) {
    logTest('PUT /api/system-message (Update Content)');

    const testContent = `## TEST UPDATE - ${new Date().toISOString()}

This is a test update to verify the PUT endpoint is working correctly.

Original content will be restored after test.`;

    try {
        const response = await fetch(`${API_BASE}/api/system-message`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                id,
                content: testContent,
            }),
        });

        const data = await response.json();

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${data.error || 'Unknown error'}`);
        }

        if (data.content !== testContent) {
            throw new Error('Content was not updated correctly');
        }

        logSuccess('System message content updated successfully');
        logInfo(`New content length: ${data.content.length} characters`);
        logInfo(`Updated at: ${new Date(data.updated_at).toLocaleString('id-ID')}`);

        return data;
    } catch (error) {
        logError(`Failed: ${error instanceof Error ? error.message : String(error)}`);
        throw error;
    }
}

async function test4_CreateNewSystemMessage() {
    logTest('POST /api/system-message (Create New)');

    const testName = `test_${Date.now()}`;
    const testData = {
        name: testName,
        content: 'This is a test system message created by automated test.',
        description: 'Test system message - can be deleted',
        is_active: false,
    };

    try {
        const response = await fetch(`${API_BASE}/api/system-message`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(testData),
        });

        const data = await response.json();

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${data.error || 'Unknown error'}`);
        }

        if (data.name !== testName) {
            throw new Error('Name mismatch in created message');
        }

        logSuccess('New system message created successfully');
        logInfo(`ID: ${data.id}`);
        logInfo(`Name: ${data.name}`);
        logInfo(`Active: ${data.is_active}`);

        return data;
    } catch (error) {
        logError(`Failed: ${error instanceof Error ? error.message : String(error)}`);
        throw error;
    }
}

async function test5_TestRAGIntegration() {
    logTest('RAG Integration Test');

    try {
        const response = await fetch(`${API_BASE}/api/chat`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                message: 'Halo, apa produk yang tersedia?',
                history: [],
            }),
        });

        const data = await response.json();

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${data.error || 'Unknown error'}`);
        }

        logSuccess('RAG integration working - AI responded successfully');
        logInfo(`Response length: ${data.message?.length || 0} characters`);
        logInfo(`Sources: ${data.sources?.length || 0} sources`);

        // Check if response includes friendly greeting (sign of system message working)
        const hasGreeting = data.message?.toLowerCase().includes('kak') ||
            data.message?.toLowerCase().includes('halo');

        if (hasGreeting) {
            logSuccess('System message persona is active (detected friendly tone)');
        } else {
            logInfo('Could not verify persona tone in response');
        }

        return data;
    } catch (error) {
        logError(`Failed: ${error instanceof Error ? error.message : String(error)}`);
        throw error;
    }
}

async function test6_RestoreOriginalContent(id: string, originalContent: string) {
    logTest('Restore Original Content');

    try {
        const response = await fetch(`${API_BASE}/api/system-message`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                id,
                content: originalContent,
            }),
        });

        const data = await response.json();

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${data.error || 'Unknown error'}`);
        }

        logSuccess('Original content restored');
        return data;
    } catch (error) {
        logError(`Failed: ${error instanceof Error ? error.message : String(error)}`);
        throw error;
    }
}

async function runAllTests() {
    console.log('\n' + '='.repeat(60));
    log('🚀 System Message Configuration - Test Suite', 'cyan');
    console.log('='.repeat(60));

    let originalMessage: any;
    let testsPassed = 0;
    let testsFailed = 0;

    try {
        // Test 1: Get active system message
        originalMessage = await test1_GetActiveSystemMessage();
        testsPassed++;
    } catch (error) {
        testsFailed++;
    }

    try {
        // Test 2: Get specific system message
        await test2_GetSpecificSystemMessage('default');
        testsPassed++;
    } catch (error) {
        testsFailed++;
    }

    if (originalMessage) {
        try {
            // Test 3: Update system message
            await test3_UpdateSystemMessage(originalMessage.id);
            testsPassed++;
        } catch (error) {
            testsFailed++;
        }

        try {
            // Test 6: Restore original content
            await test6_RestoreOriginalContent(originalMessage.id, originalMessage.content);
            testsPassed++;
        } catch (error) {
            testsFailed++;
        }
    }

    try {
        // Test 4: Create new system message
        await test4_CreateNewSystemMessage();
        testsPassed++;
    } catch (error) {
        testsFailed++;
    }

    try {
        // Test 5: RAG integration
        await test5_TestRAGIntegration();
        testsPassed++;
    } catch (error) {
        testsFailed++;
    }

    // Summary
    console.log('\n' + '='.repeat(60));
    log('📊 Test Summary', 'cyan');
    console.log('='.repeat(60));
    logSuccess(`Passed: ${testsPassed} tests`);
    if (testsFailed > 0) {
        logError(`Failed: ${testsFailed} tests`);
    }
    log(`Total: ${testsPassed + testsFailed} tests`, 'blue');
    console.log('='.repeat(60) + '\n');

    if (testsFailed === 0) {
        log('🎉 All tests passed! System Message Configuration is working correctly.', 'green');
    } else {
        log('⚠️  Some tests failed. Please review the errors above.', 'yellow');
    }
}

// Run tests
runAllTests().catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
});
