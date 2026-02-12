#!/usr/bin/env node

/**
 * Test script to verify Anthropic OAuth usage API works
 * Based on: https://codelynx.dev/posts/claude-code-usage-limits-statusline
 */

let apiKey = process.env.ANTHROPIC_API_KEY;

if (!apiKey) {
  console.error('❌ ANTHROPIC_API_KEY environment variable not set');
  process.exit(1);
}

// Check if it's a JSON OAuth credential
try {
  const parsed = JSON.parse(apiKey);
  if (parsed.claudeAiOauth?.accessToken) {
    console.log('✓ Found OAuth credentials in keychain');
    apiKey = parsed.claudeAiOauth.accessToken;
    console.log('✓ Extracted access token (length: ' + apiKey.length + ')');
  }
} catch (e) {
  // Not JSON, assume it's a direct API key
  console.log('✓ Using direct API key (length: ' + apiKey.length + ')');
}

console.log('\nTesting Anthropic OAuth usage API...\n');

try {
  // Try with Bearer token (OAuth)
  console.log('Attempt 1: Using Authorization Bearer header...');
  let response = await fetch('https://api.anthropic.com/api/oauth/usage', {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'anthropic-beta': 'oauth-2025-04-20',
      'anthropic-version': '2023-06-01',
    },
  });

  if (response.status === 401) {
    console.log('❌ Bearer token failed, trying x-api-key header...\n');
    response = await fetch('https://api.anthropic.com/api/oauth/usage', {
      method: 'GET',
      headers: {
        'x-api-key': apiKey,
        'anthropic-beta': 'oauth-2025-04-20',
        'anthropic-version': '2023-06-01',
      },
    });
  }

  console.log('Response status:', response.status, response.statusText);
  console.log('Response headers:');
  for (const [key, value] of response.headers.entries()) {
    console.log(`  ${key}: ${value}`);
  }

  const text = await response.text();
  console.log('\nRaw response body:');
  console.log(text);

  if (response.ok) {
    try {
      const data = JSON.parse(text);
      console.log('\n✅ Parsed JSON response:');
      console.log(JSON.stringify(data, null, 2));

      if (data.five_hour && data.seven_day) {
        console.log('\n✅ Usage limits data structure is correct!');
        console.log(`  5-hour:  ${data.five_hour.utilization}% (resets at ${data.five_hour.resets_at})`);
        console.log(`  7-day:   ${data.seven_day.utilization}% (resets at ${data.seven_day.resets_at})`);
      } else {
        console.log('\n⚠️  Response structure differs from expected');
      }
    } catch (e) {
      console.error('\n❌ Failed to parse JSON:', e.message);
    }
  } else {
    console.error('\n❌ API request failed');
  }
} catch (error) {
  console.error('\n❌ Error:', error.message);
  process.exit(1);
}
