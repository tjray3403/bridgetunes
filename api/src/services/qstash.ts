export async function publishQStashMessage(
  destination: string,
  body: unknown,
  deduplicationId: string,
  label?: string,
): Promise<void> {
  if (process.env.LOCAL_LOAD_TEST === 'true') {
    if (process.env.NODE_ENV === 'production') throw new Error('LOCAL_LOAD_TEST cannot be enabled in production');
    const response = await fetch(destination, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`Local load-test worker rejected message (${response.status})`);
    return;
  }

  const token = process.env.QSTASH_TOKEN;
  if (!token) throw new Error('QStash token is not configured');

  const baseUrl = (process.env.QSTASH_URL || 'https://qstash.upstash.io').replace(/\/+$/, '');
  const response = await fetch(`${baseUrl}/v2/publish/${destination}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Upstash-Deduplication-Id': deduplicationId,
      'Upstash-Retries': '4',
      'Upstash-Retry-Delay': 'max(30000, pow(2, retried) * 30000)',
      'Upstash-Flow-Control-Key': 'bridgetunes-playlist-matching',
      'Upstash-Flow-Control-Value': 'parallelism=2,rate=8,period=1m',
      ...(label ? { 'Upstash-Label': label } : {}),
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const detail = (await response.text()).slice(0, 500);
    throw new Error(`QStash rejected message (${response.status})${detail ? `: ${detail}` : ''}`);
  }
}

export async function cancelPlaylistRun(playlistId: string, runId?: string): Promise<number> {
  if (!runId || process.env.LOCAL_LOAD_TEST === 'true') return 0;

  const token = process.env.QSTASH_TOKEN;
  if (!token) throw new Error('QStash token is not configured');

  const baseUrl = (process.env.QSTASH_URL || 'https://qstash.upstash.io').replace(/\/+$/, '');
  const query = new URLSearchParams({ label: `match-${playlistId}-${runId}`, count: '500', async: 'true' });
  const response = await fetch(`${baseUrl}/v2/messages?${query}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!response.ok) {
    const detail = (await response.text()).slice(0, 500);
    throw new Error(`QStash could not cancel the previous playlist run (${response.status})${detail ? `: ${detail}` : ''}`);
  }

  const result = await response.json() as { cancelled?: number };
  return Number(result.cancelled || 0);
}
