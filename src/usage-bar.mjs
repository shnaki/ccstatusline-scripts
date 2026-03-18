import { readFile, writeFile, open, unlink, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const BAR_WIDTH = 10;
const CACHE_PATH = join(homedir(), '.claude', 'usage-bar-cache.json');
const LOCK_PATH = join(homedir(), '.claude', 'usage-bar-cache.lock');
const CACHE_TTL_MS = (Number(process.env.USAGE_BAR_TTL_SECONDS) || 300) * 1000;
const STALE_LOCK_MS = 30_000;
const WAIT_INTERVAL_MS = 500;
const WAIT_MAX_RETRIES = 6;

async function readCache(allowStale = false) {
  try {
    const raw = JSON.parse(await readFile(CACHE_PATH, 'utf8'));
    if (Date.now() - raw.timestamp < CACHE_TTL_MS) return { data: raw.data, fetchedAt: raw.timestamp };
    if (allowStale && raw.data) return { data: raw.data, fetchedAt: raw.timestamp, stale: true };
  } catch {}
  return null;
}

async function writeCache(data) {
  try {
    await writeFile(CACHE_PATH, JSON.stringify({ timestamp: Date.now(), data }));
  } catch {}
}

async function acquireLock() {
  try {
    const fd = await open(LOCK_PATH, 'wx');
    await fd.close();
    return true;
  } catch (e) {
    if (e.code === 'EEXIST') return false;
    throw e;
  }
}

async function releaseLock() {
  try { await unlink(LOCK_PATH); } catch {}
}

async function cleanStaleLock() {
  try {
    const st = await stat(LOCK_PATH);
    if (Date.now() - st.mtimeMs > STALE_LOCK_MS) {
      await unlink(LOCK_PATH);
      return true;
    }
  } catch {}
  return false;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForCache(previousTimestamp) {
  for (let i = 0; i < WAIT_MAX_RETRIES; i++) {
    await sleep(WAIT_INTERVAL_MS);
    const cached = await readCache();
    if (cached && cached.fetchedAt !== previousTimestamp) return cached;
  }
  return null;
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

function formatAgo(timestamp) {
  const sec = Math.floor((Date.now() - timestamp) / 1000);
  if (sec < 5) return 'just now';
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  return `${hr}h${min % 60}m ago`;
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

    let cached = await readCache();
    let data;
    let fetchedAt;
    let stale = false;

    if (cached) {
      data = cached.data;
      fetchedAt = cached.fetchedAt;
    } else {
      // Cache expired — try to acquire lock for API fetch
      const staleCache = await readCache(true);
      let locked = await acquireLock();

      if (!locked) {
        // Another process is fetching — clean stale lock if needed and retry
        if (await cleanStaleLock()) {
          locked = await acquireLock();
        }
      }

      if (locked) {
        try {
          const res = await fetch(USAGE_URL, {
            headers: {
              'Content-Type': 'application/json',
              'User-Agent': 'claude-code/2.1.71',
              'Authorization': `Bearer ${token}`,
              'anthropic-beta': 'oauth-2025-04-20',
            },
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
          fetchedAt = Date.now();
        } finally {
          await releaseLock();
        }
      } else {
        // Wait for the other process to update the cache
        const updated = await waitForCache(staleCache?.fetchedAt);
        if (updated) {
          data = updated.data;
          fetchedAt = updated.fetchedAt;
        } else if (staleCache) {
          data = staleCache.data;
          fetchedAt = staleCache.fetchedAt;
          stale = true;
        } else {
          process.stdout.write('[waiting]');
          return;
        }
      }
    }
    const h5 = data.five_hour;
    const d7 = data.seven_day;
    const ago = formatAgo(fetchedAt);

    const out =
      `5h [${makeBar(h5.utilization)}] ${Math.round(h5.utilization)}% ${formatRemaining(h5.resets_at)}` +
      ` | 7d [${makeBar(d7.utilization)}] ${Math.round(d7.utilization)}% ${formatRemaining(d7.resets_at)}` +
      ` (${ago}${stale ? ' stale' : ''})`;

    process.stdout.write(out);
  } catch (e) {
    if (e.code === 'ENOENT') process.stdout.write('[no auth]');
    else process.stdout.write('[API err]');
  }
}

main();
