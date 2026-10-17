const tokenKey = 'bridgetunes-spotify-access-token';
const verifierKey = 'bridgetunes-spotify-code-verifier';
const stateKey = 'bridgetunes-spotify-oauth-state';

type SessionToken = { accessToken: string; expiresAt: number; scopes?: string[] };

function clientId(): string {
  const value = import.meta.env.VITE_SPOTIFY_CLIENT_ID;
  if (!value) throw new Error('Spotify sign-in is not configured.');
  return value;
}

export function spotifyRedirectUri(): string {
  return import.meta.env.VITE_SPOTIFY_REDIRECT_URI || `${window.location.origin}/spotify/callback`;
}

function encodeBase64Url(bytes: Uint8Array): string {
  let value = '';
  for (const byte of bytes) value += String.fromCharCode(byte);
  return btoa(value).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function randomBase64Url(byteCount: number): string {
  return encodeBase64Url(crypto.getRandomValues(new Uint8Array(byteCount)));
}

export async function spotifyAuthorizationUrl(): Promise<string> {
  const verifier = randomBase64Url(64);
  const state = randomBase64Url(32);
  sessionStorage.setItem(verifierKey, verifier);
  sessionStorage.setItem(stateKey, state);

  const challenge = encodeBase64Url(new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)),
  ));
  const params = new URLSearchParams({
    client_id: clientId(),
    response_type: 'code',
    redirect_uri: spotifyRedirectUri(),
    scope: 'playlist-read-private playlist-read-collaborative user-read-private playlist-modify-private playlist-modify-public',
    state,
    code_challenge_method: 'S256',
    code_challenge: challenge,
  });
  return `https://accounts.spotify.com/authorize?${params.toString()}`;
}

export async function completeSpotifyAuthorization(code: string, returnedState: string | null): Promise<string> {
  const expectedState = sessionStorage.getItem(stateKey);
  const verifier = sessionStorage.getItem(verifierKey);
  sessionStorage.removeItem(stateKey);
  sessionStorage.removeItem(verifierKey);
  if (!expectedState || !verifier || returnedState !== expectedState) {
    throw new Error('Spotify sign-in could not be verified. Please try again.');
  }

  const response = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId(),
      grant_type: 'authorization_code',
      code,
      redirect_uri: spotifyRedirectUri(),
      code_verifier: verifier,
    }),
  });
  if (!response.ok) throw new Error('Spotify could not complete sign-in. Please try again.');

  const data = await response.json() as { access_token: string; expires_in: number; scope?: string };
  const token: SessionToken = {
    accessToken: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
    scopes: data.scope?.split(' '),
  };
  sessionStorage.setItem(tokenKey, JSON.stringify(token));
  return token.accessToken;
}

export function currentSpotifyAccessToken(requiredScopes: string[] = []): string | undefined {
  const stored = sessionStorage.getItem(tokenKey);
  if (!stored) return undefined;
  try {
    const token = JSON.parse(stored) as SessionToken;
    if (!token.accessToken || token.expiresAt <= Date.now() + 30_000 || requiredScopes.some((scope) => !token.scopes?.includes(scope))) {
      sessionStorage.removeItem(tokenKey);
      return undefined;
    }
    return token.accessToken;
  } catch {
    sessionStorage.removeItem(tokenKey);
    return undefined;
  }
}
