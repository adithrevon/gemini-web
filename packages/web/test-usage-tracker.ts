#!/usr/bin/env tsx
/**
 * Ad-hoc test script to verify usage tracking logic
 * Run with: npx tsx test-usage-tracker.ts
 */

import { readdir, readFile } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';

interface SessionData {
  sessionId: string;
  startTime: number;
  endTime: number;
  durationHours: number;
  promptCount: number;
  sonnetResponses: number;
  opusResponses: number;
  project: string;
}

interface UsageLimits {
  current5h: {
    startTime: number;
    totalPrompts: number;
    limit: number;
  };
  currentWeek: {
    startTime: number;
    sonnet4Hours: number;
    opus4Hours: number;
    totalPrompts: number;
    sonnetLimit: number;
    opusLimit: number;
  };
  lastUpdated: number;
}

class UsageTracker {
  private claudeProjects: string;

  constructor() {
    this.claudeProjects = join(homedir(), '.claude', 'projects');
    console.log('📂 Claude projects directory:', this.claudeProjects);
  }

  private getWeekStart(): number {
    const now = new Date();
    const daysSinceMonday = now.getDay() === 0 ? 6 : now.getDay() - 1;
    const monday = new Date(now);
    monday.setDate(now.getDate() - daysSinceMonday);
    monday.setHours(0, 0, 0, 0);
    return monday.getTime();
  }

  private get5hCycleStart(): number {
    const now = Date.now();
    const hoursSinceEpoch = now / 3600000;
    const cycleNumber = Math.floor(hoursSinceEpoch / 5);
    return cycleNumber * 5 * 3600000;
  }

  private parseTimestamp(ts: string): number | null {
    if (!ts || ts === 'null') return null;
    try {
      const cleanTs = ts.includes('.') ? ts.split('.')[0] + 'Z' : ts;
      return new Date(cleanTs).getTime();
    } catch {
      return null;
    }
  }

  private isCommandMessage(content: any): boolean {
    if (typeof content === 'string') {
      return content.includes('<command-name>') ||
             content.includes('<local-command-stdout>');
    } else if (Array.isArray(content)) {
      return content.some(item =>
        item.type === 'text' &&
        (item.text?.includes('<command-name>') ||
         item.text?.includes('<local-command-stdout>'))
      );
    }
    return false;
  }

  private async analyzeJsonlFile(jsonlPath: string): Promise<SessionData> {
    const timestamps: number[] = [];
    let prompts = 0;
    let sonnetResponses = 0;
    let opusResponses = 0;

    try {
      const content = await readFile(jsonlPath, 'utf-8');
      const lines = content.split('\n').filter(l => l.trim());

      for (const line of lines) {
        try {
          const msg = JSON.parse(line);

          // Collect timestamp
          if (msg.timestamp) {
            const epoch = this.parseTimestamp(msg.timestamp);
            if (epoch) timestamps.push(epoch);
          }

          // Count user prompts (excluding commands and meta)
          if (msg.type === 'user' &&
              msg.message?.role === 'user' &&
              !msg.isMeta &&
              msg.userType === 'external') {
            const content = msg.message?.content;
            if (content && !this.isCommandMessage(content)) {
              prompts++;
            }
          }

          // Count model responses
          else if (msg.type === 'assistant') {
            const model = (msg.message?.model || '').toLowerCase();
            if (model.includes('opus')) {
              opusResponses++;
            } else if (model.includes('sonnet')) {
              sonnetResponses++;
            }
          }
        } catch (e) {
          // Skip invalid lines
        }
      }
    } catch (e) {
      console.error(`  ❌ Error reading ${jsonlPath}:`, e);
    }

    // Calculate session duration
    let durationHours = 0;
    let startTime = 0;
    let endTime = 0;

    if (timestamps.length > 0) {
      startTime = Math.min(...timestamps);
      endTime = Math.max(...timestamps);
      durationHours = (endTime - startTime) / 3600000;
    }

    const sessionId = jsonlPath.split('/').pop()?.replace('.jsonl', '') || '';
    const project = jsonlPath.split('/').slice(-2, -1)[0] || '';

    return {
      sessionId,
      startTime,
      endTime,
      durationHours,
      promptCount: prompts,
      sonnetResponses,
      opusResponses,
      project
    };
  }

  private async getAllSessions(): Promise<SessionData[]> {
    const sessions: SessionData[] = [];

    try {
      const projects = await readdir(this.claudeProjects, { withFileTypes: true });

      for (const project of projects) {
        if (project.isDirectory()) {
          const projectPath = join(this.claudeProjects, project.name);
          const files = await readdir(projectPath);

          const jsonlFiles = files.filter(f => f.endsWith('.jsonl'));
          console.log(`\n📁 Project: ${project.name} (${jsonlFiles.length} sessions)`);

          for (const file of jsonlFiles) {
            const session = await this.analyzeJsonlFile(
              join(projectPath, file)
            );
            if (session.durationHours > 0) {
              sessions.push(session);
              console.log(`  ✓ ${file}: ${session.promptCount} prompts, ${session.durationHours.toFixed(2)}h, S:${session.sonnetResponses} O:${session.opusResponses}`);
            }
          }
        }
      }
    } catch (e) {
      console.error('❌ Error reading projects directory:', e);
    }

    return sessions;
  }

  async calculateUsage(): Promise<UsageLimits> {
    console.log('\n🔍 Calculating usage...\n');

    const sessions = await this.getAllSessions();
    const weekStart = this.getWeekStart();
    const cycleStart = this.get5hCycleStart();

    console.log('\n📊 Time windows:');
    console.log(`  5-hour cycle start: ${new Date(cycleStart).toISOString()}`);
    console.log(`  Week start (Monday): ${new Date(weekStart).toISOString()}`);

    // Filter sessions
    const weekSessions = sessions.filter(s => s.startTime >= weekStart);
    const cycleSessions = sessions.filter(s => s.startTime >= cycleStart);

    console.log(`\n📈 Sessions in scope:`);
    console.log(`  Current 5-hour cycle: ${cycleSessions.length} sessions`);
    console.log(`  Current week: ${weekSessions.length} sessions`);

    // 5-hour cycle stats
    const cyclePrompts = cycleSessions.reduce(
      (sum, s) => sum + s.promptCount,
      0
    );

    // Weekly stats
    const weeklyPrompts = weekSessions.reduce(
      (sum, s) => sum + s.promptCount,
      0
    );

    // Model-specific hours
    let sonnetHours = 0;
    let opusHours = 0;

    for (const session of weekSessions) {
      const totalResponses = session.sonnetResponses + session.opusResponses;
      if (totalResponses > 0) {
        const sonnetRatio = session.sonnetResponses / totalResponses;
        const opusRatio = session.opusResponses / totalResponses;
        sonnetHours += session.durationHours * sonnetRatio;
        opusHours += session.durationHours * opusRatio;
      }
    }

    return {
      current5h: {
        startTime: cycleStart,
        totalPrompts: cyclePrompts,
        limit: 200
      },
      currentWeek: {
        startTime: weekStart,
        sonnet4Hours: Math.round(sonnetHours * 100) / 100,
        opus4Hours: Math.round(opusHours * 100) / 100,
        totalPrompts: weeklyPrompts,
        sonnetLimit: 50,
        opusLimit: 25
      },
      lastUpdated: Date.now()
    };
  }
}

// Run the tracker
async function main() {
  console.log('🚀 Testing Usage Tracker\n');
  console.log('='.repeat(60));

  const tracker = new UsageTracker();
  const usage = await tracker.calculateUsage();

  console.log('\n' + '='.repeat(60));
  console.log('\n📊 USAGE SUMMARY\n');

  console.log('5-Hour Cycle:');
  console.log(`  Prompts: ${usage.current5h.totalPrompts} / ${usage.current5h.limit}`);
  console.log(`  Usage: ${((usage.current5h.totalPrompts / usage.current5h.limit) * 100).toFixed(1)}%`);

  console.log('\nWeekly Limits:');
  console.log(`  Sonnet 4 hours: ${usage.currentWeek.sonnet4Hours} / ${usage.currentWeek.sonnetLimit}`);
  console.log(`  Opus 4 hours: ${usage.currentWeek.opus4Hours} / ${usage.currentWeek.opusLimit}`);
  console.log(`  Total prompts: ${usage.currentWeek.totalPrompts}`);

  console.log('\nUtilization:');
  console.log(`  Sonnet: ${((usage.currentWeek.sonnet4Hours / usage.currentWeek.sonnetLimit) * 100).toFixed(1)}%`);
  console.log(`  Opus: ${((usage.currentWeek.opus4Hours / usage.currentWeek.opusLimit) * 100).toFixed(1)}%`);

  console.log('\n' + '='.repeat(60));
  console.log('\n✅ Test complete!\n');

  // Output as JSON for easy comparison
  console.log('JSON output:');
  console.log(JSON.stringify(usage, null, 2));
}

main().catch(console.error);
