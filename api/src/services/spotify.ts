let cachedToken: { value: string; expiresAt: number } | undefined;

export async function getSpotifyAppToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 30_000) return cachedToken.value;

  const clientId = process.env.SPOTIFY_CLIENT_ID;
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error('Spotify app credentials are not configured');

  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const tokenUrl = process.env.SPOTIFY_TOKEN_URL || 'https://accounts.spotify.com/api/token';
  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ grant_type: 'client_credentials' }),
  });
  if (!response.ok) throw new Error(`Spotify token request failed (${response.status})`);

  const data = await response.json() as { access_token: string; expires_in: number };
  cachedToken = { value: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
  return cachedToken.value;
}

async function spotifyJson<T>(url: string, accessToken: string): Promise<T> {
  const response = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!response.ok) {
    const error = new Error(`Spotify API request failed (${response.status})`) as Error & { status: number };
    error.status = response.status;
    throw error;
  }
  return response.json() as Promise<T>;
}

export async function getSpotifyUserId(accessToken: string): Promise<string> {
  const profile = await spotifyJson<{ id: string }>('https://api.spotify.com/v1/me', accessToken);
  return profile.id;
}

export async function getSpotifyPlaylistOwnerId(accessToken: string, playlistId: string): Promise<string> {
  const url = new URL(`https://api.spotify.com/v1/playlists/${encodeURIComponent(playlistId)}`);
  url.searchParams.set('fields', 'owner(id)');
  const playlist = await spotifyJson<{ owner?: { id?: string } }>(url.toString(), accessToken);
  if (!playlist.owner?.id) throw new Error('Spotify did not return the playlist owner.');
  return playlist.owner.id;
}
