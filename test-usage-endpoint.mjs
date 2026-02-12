#!/usr/bin/env node

/**
 * Test the backend /api/usage-limits endpoint
 */

const BASE_URL = 'http://127.0.0.1:7337';

console.log('Testing backend /api/usage-limits endpoint...\n');

try {
  const response = await fetch(`${BASE_URL}/api/usage-limits`);

  console.log('Response status:', response.status, response.statusText);
  console.log('Response headers:');
  for (const [key, value] of response.headers.entries()) {
    console.log(`  ${key}: ${value}`);
  }

  const text = await response.text();
  console.log('\nRaw response:');
  console.log(text);

  if (response.ok) {
    try {
      const data = JSON.parse(text);
      console.log('\n✅ Parsed JSON:');
      console.log(JSON.stringify(data, null, 2));

      if (data.five_hour && data.seven_day) {
        console.log('\n✅ Usage limits structure is correct!');
        console.log(`  5-hour:  ${data.five_hour.utilization}%`);
        console.log(`  7-day:   ${data.seven_day.utilization}%`);
      }
    } catch (e) {
      console.error('\n❌ Failed to parse JSON:', e.message);
    }
  } else {
    console.error('\n❌ Request failed');
    if (response.status === 503) {
      console.error('  → Server says usage tracking not available');
      console.error('  → Check if ANTHROPIC_API_KEY is set or keychain is accessible');
    }
  }
} catch (error) {
  console.error('\n❌ Error:', error.message);
  console.error('  → Is the backend server running on port 7337?');
  process.exit(1);
}
