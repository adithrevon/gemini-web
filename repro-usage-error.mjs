import { execSync } from 'node:child_process';

async function test() {
  try {
    const command = 'security find-generic-password -s "Claude Code-credentials" -w';
    const result = execSync(command, { encoding: 'utf-8' });
    const credentials = result.trim();
    
    let accessToken;
    try {
      const parsed = JSON.parse(credentials);
      accessToken = parsed.claudeAiOauth?.accessToken || credentials;
    } catch {
      accessToken = credentials;
    }

    console.log('Access token length:', accessToken.length);
    console.log('Access token preview:', accessToken.substring(0, 15) + '...');

    const response = await fetch('https://api.anthropic.com/api/oauth/usage', {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'anthropic-version': '2023-06-01',
      },
    });

    console.log('Status:', response.status, response.statusText);
    const text = await response.text();
    console.log('Response body:', text);
  } catch (error) {
    console.error('Error:', error.message);
  }
}

test();
