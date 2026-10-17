import { getAppleDeveloperToken } from './api';

type AppleMusicInstance = {
  authorize(): Promise<string>;
};

type AppleMusicGlobal = {
  configure(options: { developerToken: string; app: { name: string; build: string } }): void | Promise<void>;
  getInstance(): AppleMusicInstance;
};

declare global {
  interface Window {
    MusicKit?: AppleMusicGlobal;
  }
}

export type AppleCreationProgress = { stage: 'authorizing' | 'creating' };

let scriptPromise: Promise<void> | undefined;
let configurePromise: Promise<void> | undefined;
let developerToken: string | undefined;

function loadMusicKit(): Promise<void> {
  if (window.MusicKit) return Promise.resolve();
  if (!scriptPromise) {
    scriptPromise = new Promise<void>((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'https://js-cdn.music.apple.com/musickit/v3/musickit.js';
      script.async = true;
      script.onload = () => window.MusicKit ? resolve() : reject(new Error('Apple MusicKit did not initialize.'));
      script.onerror = () => reject(new Error('Could not load Apple MusicKit. Check your connection and try again.'));
      document.head.appendChild(script);
    }).catch((error: unknown) => {
      scriptPromise = undefined;
      throw error;
    });
  }
  return scriptPromise!;
}

export async function prepareAppleMusic(): Promise<void> {
  await loadMusicKit();
  if (!configurePromise) {
    configurePromise = (async () => {
      developerToken = await getAppleDeveloperToken();
      await window.MusicKit!.configure({
        developerToken,
        app: { name: 'BridgeTunes', build: '1.0.0' },
      });
    })().catch((error: unknown) => {
      configurePromise = undefined;
      developerToken = undefined;
      throw error;
    });
  }
  await configurePromise;
}

export async function authorizeAppleMusic(): Promise<string> {
  await prepareAppleMusic();
  return window.MusicKit!.getInstance().authorize();
}

export async function createAppleMusicPlaylist(
  musicUserToken: string,
  name: string,
  catalogSongIds: string[],
  onProgress?: (progress: AppleCreationProgress) => void,
): Promise<string> {
  if (!developerToken) throw new Error('Apple Music is not ready. Please try again.');
  if (catalogSongIds.length === 0) throw new Error('There are no Apple Music matches to add.');

  onProgress?.({ stage: 'creating' });
  const response = await fetch('https://api.music.apple.com/v1/me/library/playlists', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${developerToken}`,
      'Music-User-Token': musicUserToken,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      attributes: { name, description: 'Created with BridgeTunes', isPublic: false },
      relationships: {
        tracks: { data: catalogSongIds.map((id) => ({ id, type: 'songs' })) },
      },
    }),
  });

  if (!response.ok) {
    let detail = '';
    try {
      const data = await response.json() as { errors?: Array<{ detail?: string; title?: string }> };
      detail = data.errors?.[0]?.detail || data.errors?.[0]?.title || '';
    } catch {
      // Use the general message below if Apple returns a non-JSON error.
    }
    if (response.status === 401 || response.status === 403) {
      throw new Error(detail || 'Apple Music authorization was denied. Connect an Apple Music subscriber account and try again.');
    }
    throw new Error(detail || `Apple Music could not create the playlist (HTTP ${response.status}).`);
  }

  const data = await response.json() as { data?: Array<{ id: string }> };
  const playlistId = data.data?.[0]?.id;
  if (!playlistId) throw new Error('Apple Music created the playlist but did not return its link.');
  return `https://music.apple.com/library/playlist/${encodeURIComponent(playlistId)}`;
}
