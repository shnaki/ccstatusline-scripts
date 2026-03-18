import { readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const BAR_WIDTH = 10;
const CACHE_PATH = join(homedir(), '.claude', 'usage-bar-cache.json');
const CACHE_TTL_MS = (Number(process.env.USAGE_BAR_TTL_SECONDS) || 300) * 1000;

async function readCache() {
  try {
    const raw = JSON.parse(await readFile(CACHE_PATH, 'utf8'));
    if (Date.now() - raw.timestamp < CACHE_TTL_MS) return raw.data;
  } catch {}
  return null;
}

async function writeCache(data) {
  try {
    await writeFile(CACHE_PATH, JSON.stringify({ timestamp: Date.now(), data }));
  } catch {}
}

const FILLED = '\u2588';
const EMPTY = '\u2591';
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';

function colorize(text, pct) {
  const code = pct >= 80 ? '31' : pct >= 50 ? '33' : '32';
  return `\x1b[${code}m${text}\x1b[0m`;
}

function makeBar(pct) {
  const filled = Math.round((pct / 100) * BAR_WIDTH);
  const empty = BAR_WIDTH - filled;
  return colorize(FILLED.repeat(filled) + EMPTY.repeat(empty), pct);
}

function formatRemaining(resetAt) {
  const diff = new Date(resetAt) - Date.now();
  if (diff <= 0) return '0m';
  const totalMin = Math.floor(diff / 60000);
  const days = Math.floor(totalMin / 1440);
  const hours = Math.floor((totalMin % 1440) / 60);
  const mins = totalMin % 60;
  if (days > 0) return `${days}d${hours}h`;
  if (hours > 0) return `${hours}h${mins}m`;
  return `${mins}m`;
}

async function main() {
  try {
    const credPath = join(homedir(), '.claude', '.credentials.json');
    const creds = JSON.parse(await readFile(credPath, 'utf8'));
    const token = creds.claudeAiOauth?.accessToken;
    if (!token) {
      process.stdout.write('[no auth]');
      return;
    }

    let data = await readCache();

    if (!data) {
      const res = await fetch(USAGE_URL, {
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'claude-code/2.1.71',
          'Authorization': `Bearer ${token}`,
          'anthropic-beta': 'oauth-2025-04-20',
        },
        // Avoid AbortSignal.timeout here to reduce chances of libuv assertion on Windows
      });

      if (res.status === 429) {
        const retry = res.headers.get('retry-after');
        const msg = retry ? `[rate limited ${Math.ceil(retry / 60)}m]` : '[rate limited]';
        process.stdout.write(msg);
        return;
      }

      if (!res.ok) {
        process.stdout.write('[API err]');
        return;
      }

      data = await res.json();
      await writeCache(data);
    }
    const h5 = data.five_hour;
    const d7 = data.seven_day;

    const out =
      `5h [${makeBar(h5.utilization)}] ${Math.round(h5.utilization)}% ${formatRemaining(h5.resets_at)}` +
      ` | 7d [${makeBar(d7.utilization)}] ${Math.round(d7.utilization)}% ${formatRemaining(d7.resets_at)}`;

    process.stdout.write(out);
  } catch (e) {
    if (e.code === 'ENOENT') process.stdout.write('[no auth]');
    else process.stdout.write('[API err]');
  }
}

main();
