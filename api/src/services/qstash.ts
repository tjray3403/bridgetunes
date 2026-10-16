export async function publishQStashMessage(
  destination: string,
  body: unknown,
  deduplicationId: string,
): Promise<void> {
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
