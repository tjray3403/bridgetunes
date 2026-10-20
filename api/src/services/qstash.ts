export async function publishQStashMessage(
  destination: string,
  body: unknown,
  deduplicationId: string,
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
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const detail = (await response.text()).slice(0, 500);
    throw new Error(`QStash rejected message (${response.status})${detail ? `: ${detail}` : ''}`);
  }
}
