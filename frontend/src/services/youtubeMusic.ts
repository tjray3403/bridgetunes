import { refreshMusicFeatureFlags } from './api';

type GoogleTokenClient = { requestAccessToken(options?: { prompt?: string }): void };
type GoogleIdentity = { oauth2: { initTokenClient(options: { client_id: string; scope: string; callback: (response: { access_token?: string; error?: string }) => void }): GoogleTokenClient } };
declare global { interface Window { google?: { accounts?: GoogleIdentity } } }

export type YouTubeCreationProgress = { completed: number; total: number; playlistUrl?: string };
let scriptPromise: Promise<void> | undefined;
let tokenClient: GoogleTokenClient | undefined;

function clientId(): string {
  const id = import.meta.env.VITE_GOOGLE_CLIENT_ID;
  if (!id) throw new Error('Google sign-in is not configured.');
  return id;
}

async function loadIdentityServices(): Promise<void> {
  if (window.google?.accounts?.oauth2) return;
  if (!scriptPromise) {
    scriptPromise = new Promise<void>((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'https://accounts.google.com/gsi/client';
      script.async = true;
      script.onload = () => window.google?.accounts?.oauth2 ? resolve() : reject(new Error('Google sign-in did not initialize.'));
      script.onerror = () => reject(new Error('Could not load Google sign-in.'));
      document.head.appendChild(script);
    }).catch((error: unknown) => { scriptPromise = undefined; throw error; });
  }
  await scriptPromise;
}

export async function prepareYouTubeMusic(): Promise<void> {
  await loadIdentityServices();
  tokenClient ||= window.google!.accounts!.oauth2.initTokenClient({
    client_id: clientId(),
    scope: 'https://www.googleapis.com/auth/youtube',
    callback: () => undefined,
  });
}

function authorize(): Promise<string> {
  if (!tokenClient) return Promise.reject(new Error('Google sign-in is still loading. Please try again.'));
  return new Promise((resolve, reject) => {
    tokenClient = window.google!.accounts!.oauth2.initTokenClient({
      client_id: clientId(),
      scope: 'https://www.googleapis.com/auth/youtube',
      callback: (response) => response.access_token ? resolve(response.access_token) : reject(new Error(response.error || 'Google authorization was denied.')),
    });
    tokenClient.requestAccessToken({ prompt: 'consent' });
  });
}

export async function createYouTubeMusicPlaylist(name: string, videoIds: string[], onProgress?: (progress: YouTubeCreationProgress) => void): Promise<string> {
  if (!videoIds.length) throw new Error('There are no YouTube matches to add.');
  const token = await authorize();
  const features = await refreshMusicFeatureFlags();
  if (!features.youtubeMusic) throw new Error('YouTube Music is temporarily unavailable.');
  const request = (path: string, body: unknown) => fetch(`https://www.googleapis.com/youtube/v3/${path}?part=snippet,status`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const playlistResponse = await request('playlists', { snippet: { title: name, description: 'Created with BridgeTunes' }, status: { privacyStatus: 'private' } });
  if (!playlistResponse.ok) throw new Error(`YouTube could not create the playlist (HTTP ${playlistResponse.status}).`);
  const playlist = await playlistResponse.json() as { id?: string };
  if (!playlist.id) throw new Error('YouTube created the playlist but did not return its ID.');
  const playlistUrl = `https://music.youtube.com/playlist?list=${encodeURIComponent(playlist.id)}`;
  onProgress?.({ completed: 0, total: videoIds.length, playlistUrl });
  for (const [index, videoId] of videoIds.entries()) {
    const response = await request('playlistItems', { snippet: { playlistId: playlist.id, resourceId: { kind: 'youtube#video', videoId } } });
    if (!response.ok) throw new Error(`YouTube created the playlist but could only add ${index} of ${videoIds.length} tracks (HTTP ${response.status}).`);
    onProgress?.({ completed: index + 1, total: videoIds.length });
  }
  return playlistUrl;
}

