import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { AlertCircle, ArrowLeft, Check, CheckCircle2, Clipboard, Loader2, Music2, Sparkles } from 'lucide-react';
import { getMusicFeatureFlags, getPlaylist, hasPlaylistOwnerKey, rematchApplePlaylist, trackPlaylistVisit } from '../services/api';
import { currentSpotifyAccessToken, spotifyAuthorizationUrl } from '../services/spotifyAuth';
import { createSpotifyPlaylist, type SpotifyCreationProgress } from '../services/spotifyPlaylist';
import { authorizeAppleMusic, createAppleMusicPlaylist, prepareAppleMusic, type AppleCreationProgress } from '../services/appleMusic';
import { createYouTubeMusicPlaylist, prepareYouTubeMusic, type YouTubeCreationProgress } from '../services/youtubeMusic';

type PlaylistTrack = {
  id?: string;
  title?: string;
  artist?: string;
  durationMs?: number;
  availability?: { spotify?: string | null; apple?: string | null; youtube?: string | null };
  availabilityStatus?: { spotify?: string; apple?: string; youtube?: string };
};

type PlaylistData = {
  name?: string;
  status?: string;
  sourceService?: string;
  sourceUrl?: string;
  tracks?: PlaylistTrack[];
  progress?: { completedChunks?: number; totalChunks?: number };
  error?: string;
};

export function SmartLink() {
  const { id } = useParams<{ id: string }>();
  const [playlist, setPlaylist] = useState<PlaylistData | null>(null);
  const [error, setError] = useState('');
  const [shareMessage, setShareMessage] = useState('');
  const [spotifyBusy, setSpotifyBusy] = useState(false);
  const [spotifyProgress, setSpotifyProgress] = useState<SpotifyCreationProgress | null>(null);
  const [spotifyPlaylistUrl, setSpotifyPlaylistUrl] = useState('');
  const [appleBusy, setAppleBusy] = useState(false);
  const [appleRematching, setAppleRematching] = useState(false);
  const [appleSetupReady, setAppleSetupReady] = useState(false);
  const [appleSetupError, setAppleSetupError] = useState('');
  const [appleProgress, setAppleProgress] = useState<AppleCreationProgress | null>(null);
  const [applePlaylistUrl, setApplePlaylistUrl] = useState('');
  const [youtubeBusy, setYoutubeBusy] = useState(false);
  const [youtubeProgress, setYoutubeProgress] = useState<YouTubeCreationProgress | null>(null);
  const [youtubePlaylistUrl, setYoutubePlaylistUrl] = useState('');
  const [selectedProvider, setSelectedProvider] = useState<'spotify' | 'apple' | 'youtube'>('spotify');
  const [features, setFeatures] = useState({ spotify: true, appleMusic: true, youtubeMusic: false });
  const visitTrackedFor = useRef<string | null>(null);

  useEffect(() => {
    setPlaylist(null);
    setError('');
    setShareMessage('');
    setSelectedProvider('spotify');
    setSpotifyPlaylistUrl('');
    setApplePlaylistUrl('');
    setYoutubePlaylistUrl('');
    setSpotifyProgress(null);
    setAppleProgress(null);
  }, [id]);

  useEffect(() => {
    if (!id || visitTrackedFor.current === id) return;
    visitTrackedFor.current = id;
    void trackPlaylistVisit(id).catch(() => undefined);
  }, [id]);

  useEffect(() => {
    void getMusicFeatureFlags().then((nextFeatures) => {
      setFeatures(nextFeatures);
      if (!nextFeatures.spotify && nextFeatures.appleMusic) setSelectedProvider('apple');
      else if (!nextFeatures.spotify && !nextFeatures.appleMusic && nextFeatures.youtubeMusic) setSelectedProvider('youtube');
    });
  }, []);

  useEffect(() => {
    let active = true;
    if (!features.appleMusic) {
      setAppleSetupReady(false);
      setAppleSetupError('');
      return () => { active = false; };
    }
    void prepareAppleMusic().then(() => {
      if (active) setAppleSetupReady(true);
    }).catch((cause: unknown) => {
      if (active) setAppleSetupError(cause instanceof Error ? cause.message : 'Apple Music could not be initialized.');
    });
    return () => { active = false; };
  }, [features.appleMusic]);

  useEffect(() => {
    if (features.youtubeMusic) void prepareYouTubeMusic().catch((cause: unknown) => {
      setShareMessage(cause instanceof Error ? cause.message : 'Google sign-in could not be initialized.');
    });
  }, [features.youtubeMusic]);

  useEffect(() => {
    if (!id) return;

    let isMounted = true;
    let interval: number | undefined;
    const fetchDetails = async () => {
      try {
        const data = await getPlaylist(id) as PlaylistData;
        if (!isMounted) return;
        setPlaylist(data);
        if ((data.status === 'ready' || data.status === 'failed') && interval !== undefined) {
          window.clearInterval(interval);
        }
      } catch {
        if (isMounted) setError('Could not load this playlist link. It may have expired or the API may be unavailable.');
      }
    };

    void fetchDetails();
    interval = window.setInterval(() => void fetchDetails(), 3000);
    return () => {
      isMounted = false;
      if (interval !== undefined) window.clearInterval(interval);
    };
  }, [id]);

  if (error) {
    return (
      <main className="site-shell state-shell">
        <div className="state-card">
          <span className="state-icon state-icon-error"><AlertCircle size={22} /></span>
          <p className="eyebrow">LINK UNAVAILABLE</p>
          <h1>We couldn’t load this playlist.</h1>
          <p className="state-copy">{error}</p>
          <Link className="button button-primary" to="/">Back to BridgeTunes <ArrowLeft size={17} /></Link>
        </div>
      </main>
    );
  }

  if (!playlist) {
    return (
      <main className="site-shell state-shell">
        <div className="state-card">
          <span className="state-icon state-icon-gold"><Loader2 className="spin" size={22} /></span>
          <p className="eyebrow">BRIDGETUNES</p>
          <h1>Opening your playlist…</h1>
          <p className="state-copy">Getting the music and availability details ready.</p>
        </div>
      </main>
    );
  }

  const tracks = playlist.tracks || [];
  const totalChunks = playlist.progress?.totalChunks || 0;
  const completedChunks = playlist.progress?.completedChunks || 0;
  const progressPercent = totalChunks ? Math.min(100, Math.round((completedChunks / totalChunks) * 100)) : 0;
  const isProcessing = playlist.status === 'processing';
  const isReady = playlist.status === 'ready';
  const spotifyTrackUris = tracks
    .map((track) => playlist.sourceService === 'spotify' && track.id?.startsWith('spotify:track:')
      ? track.id
      : track.availability?.spotify)
    .filter((uri): uri is string => Boolean(uri));
  const appleTrackIds = tracks
    .map((track) => playlist.sourceService === 'apple' && track.id && !track.id.startsWith('spotify:track:')
      ? track.id
      : track.availability?.apple)
    .filter((trackId): trackId is string => Boolean(trackId));
  const youtubeVideoIds = tracks
    .map((track) => playlist.sourceService === 'youtube' && track.id ? track.id : track.availability?.youtube)
    .filter((videoId): videoId is string => Boolean(videoId));
  const canRematchApple = isReady
    && appleTrackIds.length === 0
    && Boolean(playlist.sourceUrl && hasPlaylistOwnerKey(playlist.sourceUrl, id));

  const copyShareLink = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setShareMessage('Link copied. Anyone with it can view this playlist.');
    } catch {
      setShareMessage('Could not copy automatically. Copy the page address from your browser.');
    }
  };

  const createInSpotify = async () => {
    if (spotifyTrackUris.length === 0 || spotifyBusy) return;
    const approved = window.confirm(`Allow BridgeTunes to create a private Spotify playlist named “${playlist.name || 'Your playlist'}” and add ${spotifyTrackUris.length} matched tracks?`);
    if (!approved) return;

    setSpotifyBusy(true);
    try {
      const accessToken = currentSpotifyAccessToken(['playlist-modify-private']);
      if (accessToken) {
        const spotifyUrl = await createSpotifyPlaylist(accessToken, playlist.name || 'Your playlist', spotifyTrackUris, setSpotifyProgress);
        setSpotifyPlaylistUrl(spotifyUrl);
        setShareMessage('Your Spotify playlist is ready to open.');
        setSpotifyBusy(false);
        return;
      }
      sessionStorage.setItem('bridgetunes-pending-playlist', JSON.stringify({
        mode: 'create',
        name: playlist.name || 'Your playlist',
        trackUris: spotifyTrackUris,
      }));
      window.location.assign(await spotifyAuthorizationUrl());
    } catch (cause) {
      setShareMessage(cause instanceof Error ? cause.message : 'Could not start Spotify playlist creation.');
      setSpotifyBusy(false);
    }
  };

  const createInAppleMusic = async () => {
    if (appleTrackIds.length === 0 || appleBusy) return;
    const approved = window.confirm(`Allow BridgeTunes to create a private Apple Music playlist named “${playlist.name || 'Your playlist'}” and add ${appleTrackIds.length} matched tracks?`);
    if (!approved) return;

    setAppleBusy(true);
    setAppleProgress({ stage: 'authorizing' });
    setAppleSetupError('');
    let musicKitReady = appleSetupReady;
    try {
      const musicUserToken = await authorizeAppleMusic();
      musicKitReady = true;
      setAppleSetupReady(true);
      const appleUrl = await createAppleMusicPlaylist(
        musicUserToken,
        playlist.name || 'Your playlist',
        appleTrackIds,
        setAppleProgress,
      );
      setApplePlaylistUrl(appleUrl);
      setAppleSetupError('');
      setShareMessage('Your Apple Music playlist is ready to open.');
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : 'Could not create the Apple Music playlist.';
      setShareMessage(message);
      if (!musicKitReady) setAppleSetupError(message);
    } finally {
      setAppleBusy(false);
    }
  };

  const createInYouTubeMusic = async () => {
    if (youtubeVideoIds.length === 0 || youtubeBusy) return;
    if (!window.confirm(`Allow BridgeTunes to create a private YouTube playlist named “${playlist.name || 'Your playlist'}” and add ${youtubeVideoIds.length} matched videos?`)) return;
    setYoutubeBusy(true);
    setYoutubeProgress({ completed: 0, total: youtubeVideoIds.length });
    try {
      const url = await createYouTubeMusicPlaylist(playlist.name || 'Your playlist', youtubeVideoIds, (progress) => {
        setYoutubeProgress(progress);
        if (progress.playlistUrl) setYoutubePlaylistUrl(progress.playlistUrl);
      });
      setYoutubePlaylistUrl(url);
      setShareMessage('Your YouTube Music playlist is ready to open.');
    } catch (cause) {
      setShareMessage(cause instanceof Error ? cause.message : 'Could not create the YouTube Music playlist.');
    } finally { setYoutubeBusy(false); }
  };

  const findAppleMatchesFromDatabase = async () => {
    if (!id || !playlist.sourceUrl || !canRematchApple || appleRematching) return;
    setAppleRematching(true);
    setShareMessage('Searching Apple Music with the ISRC codes saved for this playlist…');
    try {
      await rematchApplePlaylist(id, playlist.sourceUrl);
      setPlaylist((current) => current ? { ...current, status: 'processing' } : current);

      for (let attempt = 0; attempt < 90; attempt++) {
        await new Promise((resolve) => window.setTimeout(resolve, 2000));
        const updated = await getPlaylist(id) as PlaylistData;
        setPlaylist(updated);
        if (updated.status === 'failed') throw new Error(updated.error || 'Apple Music matching failed.');
        if (updated.status === 'ready') {
          const foundAppleMatch = (updated.tracks || []).some((track) => track.availability?.apple);
          setShareMessage(foundAppleMatch
            ? 'Apple Music matches are ready. You can create the playlist now.'
            : 'No Apple Music catalog matches were found for the saved ISRC codes and track details.');
          return;
        }
      }
      setShareMessage('Apple Music matching is taking longer than expected. Refresh this page to check its status.');
    } catch (cause) {
      setShareMessage(cause instanceof Error ? cause.message : 'Could not match the saved tracks with Apple Music.');
    } finally {
      setAppleRematching(false);
    }
  };

  const selectedPlaylistUrl = selectedProvider === 'spotify' ? spotifyPlaylistUrl : selectedProvider === 'apple' ? applePlaylistUrl : youtubePlaylistUrl;
  const selectedProviderBusy = selectedProvider === 'spotify' ? spotifyBusy : selectedProvider === 'apple' ? appleBusy || appleRematching : youtubeBusy;
  const selectedProviderHasMatches = selectedProvider === 'spotify'
    ? spotifyTrackUris.length > 0
    : selectedProvider === 'apple' ? appleTrackIds.length > 0 : youtubeVideoIds.length > 0;
  const selectedProviderName = selectedProvider === 'spotify' ? 'Spotify' : selectedProvider === 'apple' ? 'Apple Music' : 'YouTube Music';
  const createSelectedPlaylist = () => {
    if (selectedProvider === 'spotify') void createInSpotify();
    else if (selectedProvider === 'apple') void createInAppleMusic();
    else void createInYouTubeMusic();
  };
  const handleSelectedProviderAction = () => {
    if (selectedProvider === 'apple' && canRematchApple) void findAppleMatchesFromDatabase();
    else createSelectedPlaylist();
  };

  return (
    <main className="site-shell share-shell">
      <div className="ambient ambient-gold" aria-hidden="true" />
      <header className="site-nav page-width share-nav">
        <Link className="brand-lockup" to="/" aria-label="BridgeTunes home">
          <span className="brand-mark"><Music2 size={17} strokeWidth={2.6} /></span>
          <span>bridge<span className="brand-light">tunes</span></span>
        </Link>
        <Link className="back-link" to="/"><ArrowLeft size={15} /> Make a link</Link>
      </header>

      <section className="share-content page-width">
        <div className="share-hero">
          <div className="share-cover"><span className="cover-orb cover-orb-one" /><span className="cover-orb cover-orb-two" /><Music2 className="share-cover-note" size={30} /></div>
          <div className="share-heading">
            <div className="eyebrow"><Sparkles size={13} /> YOUR SMART LINK</div>
            <div className="source-badge"><span className={`source-dot source-${playlist.sourceService || 'spotify'}`} />{serviceName(playlist.sourceService)} PLAYLIST</div>
            <h1>{playlist.name || (isReady ? 'Your playlist' : 'Building your playlist link')}</h1>
            <p className="share-subtitle">A little more listening, wherever your people are.</p>
            <div className="share-stats"><span>{tracks.length} tracks</span><span className="stat-divider" /><span>{isReady ? 'Ready to share' : isProcessing ? 'Matching tracks' : 'Import status'}</span></div>
            <div className="share-actions">
              <button type="button" className="button button-secondary" onClick={() => void copyShareLink()}><Clipboard size={15} /> Copy link</button>
              {[features.spotify, features.appleMusic, features.youtubeMusic].filter(Boolean).length > 1 && <label className="visually-hidden" htmlFor="playlist-destination">Choose a music service</label>}
              {[features.spotify, features.appleMusic, features.youtubeMusic].filter(Boolean).length > 1 && <select
                id="playlist-destination"
                className="button button-secondary provider-select"
                value={selectedProvider}
                onChange={(event) => setSelectedProvider(event.target.value as 'spotify' | 'apple' | 'youtube')}
              >
                {features.spotify && <option value="spotify">Spotify</option>}
                {features.appleMusic && <option value="apple">Apple Music</option>}
                {features.youtubeMusic && <option value="youtube">YouTube Music</option>}
              </select>}
              {!features.spotify && !features.appleMusic && !features.youtubeMusic ? <span className="share-action-message">Playlist transfers are temporarily unavailable.</span> : null}
              {features.spotify || features.appleMusic || features.youtubeMusic ? selectedPlaylistUrl ? (
                <a className="button button-primary" href={selectedPlaylistUrl} target="_blank" rel="noreferrer"><Music2 size={15} /> Open in {selectedProviderName}</a>
              ) : (
                <button type="button" className="button button-primary" onClick={handleSelectedProviderAction} disabled={(!selectedProviderHasMatches && !canRematchApple) || selectedProviderBusy}>
                  {selectedProviderBusy ? <Loader2 className="spin" size={15} /> : <Music2 size={15} />}
                  {selectedProviderBusy
                    ? selectedProvider === 'spotify' ? 'Creating in Spotify…' : selectedProvider === 'apple' ? appleRematching ? 'Finding Apple matches…' : 'Connecting to Apple Music…' : 'Creating in YouTube Music…'
                    : canRematchApple ? 'Find Apple matches'
                    : !selectedProviderHasMatches && isProcessing ? `Waiting for ${selectedProviderName} matches`
                    : !selectedProviderHasMatches && isReady ? `No ${selectedProviderName} matches`
                    : selectedProvider === 'apple' && appleSetupError ? 'Retry Apple Music setup'
                    : selectedProvider === 'spotify' ? `Create in Spotify (${spotifyTrackUris.length})`
                    : selectedProvider === 'apple' ? `Create in Apple Music (${appleTrackIds.length})`
                    : `Create in YouTube Music (${youtubeVideoIds.length})`
                  }
                </button>
              ) : null}
            </div>
            {spotifyBusy && spotifyProgress && <SpotifyProgress progress={spotifyProgress} />}
            {appleBusy && appleProgress && <AppleProgress progress={appleProgress} />}
            {youtubeBusy && youtubeProgress && <p className="share-action-message">Adding YouTube videos: {youtubeProgress.completed} of {youtubeProgress.total}.</p>}
            {(features.spotify || features.appleMusic || features.youtubeMusic) && <p className="share-action-help">Each service will ask you to authorize creating a private playlist with the matched tracks.</p>}
            {appleSetupError && <p className="share-action-message" role="status">Apple Music setup: {appleSetupError}</p>}
            {features.appleMusic && isReady && appleTrackIds.length === 0
              ? <p className="share-action-message" role="status">{canRematchApple
                ? 'No Apple Music matches are saved yet. Find Apple matches will check the saved ISRC codes and track details; only the browser that created this link can run it.'
                : 'No Apple Music track matches are saved for this link.'}</p>
              : features.spotify && isReady && spotifyTrackUris.length === 0
                ? <p className="share-action-message" role="status">No Spotify track matches are available for this link yet.</p>
              : null}
            {shareMessage && <p className="share-action-message" role="status">{shareMessage}</p>}
          </div>
        </div>

        <section className="availability-panel" aria-label="Playlist progress and availability">
          <div className="availability-panel-heading">
            <div><span className="card-kicker">LISTENING OPTIONS</span><h2>Find your next listen</h2></div>
            <span className={`status-chip ${isReady ? 'status-ready' : playlist.status === 'failed' ? 'status-failed' : 'status-working'}`}>
              {isReady ? <CheckCircle2 size={14} /> : playlist.status === 'failed' ? <AlertCircle size={14} /> : <Loader2 className="spin" size={14} />}
              {isReady ? 'Ready' : playlist.status === 'failed' ? 'Import failed' : 'In progress'}
            </span>
          </div>
          <div className="provider-legend">
            {features.spotify && <span><i className="legend-dot legend-spotify" /> Spotify</span>}
            {features.appleMusic && <span><i className="legend-dot legend-apple" /> Apple Music</span>}
            {features.youtubeMusic && <span><i className="legend-dot legend-youtube" /> YouTube Music</span>}
            {isProcessing && <span className="match-progress-text">{progressPercent}% matched</span>}
          </div>
          {isProcessing && <div className="progress-track"><span style={{ width: `${progressPercent}%` }} /></div>}
          {playlist.status === 'failed' && <p role="alert" className="notice notice-error share-error">{playlist.error || 'Playlist processing failed. Please try the link again.'}</p>}
        </section>

        <section className="track-section">
          <div className="track-section-heading"><div><span className="card-kicker">THE PLAYLIST</span><h2>Track availability</h2></div><span className="track-count">{tracks.length} songs</span></div>
          {tracks.length === 0 && playlist.status !== 'failed' ? (
            <div className="empty-tracks"><Loader2 className="spin" size={18} /> Waiting for tracks to arrive…</div>
          ) : (
            <div className="track-list">
              {tracks.map((track, index) => (
                <article className="track-row" key={`${track.title || 'track'}-${index}`}>
                  <span className="track-number">{String(index + 1).padStart(2, '0')}</span>
                  <span className="track-art" aria-hidden="true"><Music2 size={15} /></span>
                  <div className="track-details"><strong>{track.title || 'Unknown track'}</strong><span>{track.artist || 'Unknown artist'}</span></div>
                  <div className="track-platforms">
                    <AvailabilityTag platform="spotify" available={Boolean(track.availability?.spotify)} temporarilyUnavailable={track.availabilityStatus?.spotify === 'temporarily_unavailable'} />
                    <AvailabilityTag platform="apple" available={Boolean(track.availability?.apple || (playlist.sourceService === 'apple' && track.id && !track.id.startsWith('spotify:track:')))} temporarilyUnavailable={track.availabilityStatus?.apple === 'temporarily_unavailable'} />
                    <AvailabilityTag platform="youtube" available={Boolean(track.availability?.youtube || (playlist.sourceService === 'youtube' && track.id))} temporarilyUnavailable={track.availabilityStatus?.youtube === 'temporarily_unavailable'} />
                  </div>
                  {track.durationMs ? <span className="track-duration desktop-duration">{formatDuration(track.durationMs)}</span> : null}
                </article>
              ))}
            </div>
          )}
        </section>

        <footer className="share-footer"><span><span className="brand-mark brand-mark-small"><Music2 size={13} /></span> Shared with BridgeTunes</span><span>One link. More ways to listen.</span></footer>
      </section>
    </main>
  );
}

function SpotifyProgress({ progress }: { progress: SpotifyCreationProgress }) {
  const percent = progress.stage === 'creating'
    ? 8
    : 10 + Math.round((progress.completed / Math.max(progress.total, 1)) * 90);
  const label = progress.stage === 'creating'
    ? 'Creating your private Spotify playlist…'
    : `Adding matched tracks (${progress.completed} of ${progress.total} batches)…`;
  return <div className="spotify-create-progress" aria-live="polite">
    <p>{label}</p>
    <div className="progress-track" role="progressbar" aria-label="Spotify playlist creation progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
      <span style={{ width: `${percent}%` }} />
    </div>
  </div>;
}

function AppleProgress({ progress }: { progress: AppleCreationProgress }) {
  const authorizing = progress.stage === 'authorizing';
  return <div className="spotify-create-progress" aria-live="polite">
    <p>{authorizing ? 'Waiting for Apple Music authorization…' : 'Creating your private Apple Music playlist…'}</p>
    <div className="progress-track" role="progressbar" aria-label="Apple Music playlist creation progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={authorizing ? 35 : 75}>
      <span style={{ width: `${authorizing ? 35 : 75}%` }} />
    </div>
  </div>;
}

function AvailabilityTag({ platform, available, temporarilyUnavailable = false }: { platform: 'spotify' | 'apple' | 'youtube'; available: boolean; temporarilyUnavailable?: boolean }) {
  return (
    <span className={`availability-tag ${available ? `tag-${platform}-available` : ''}`} aria-label={`${serviceName(platform)} ${available ? 'available' : temporarilyUnavailable ? 'temporarily unavailable' : 'not found'}`} title={temporarilyUnavailable ? `${serviceName(platform)} is temporarily unavailable after retries.` : undefined}>
      <i className={`tag-dot tag-dot-${platform}`} />
      <span className="tag-label">{platform === 'apple' ? 'Apple' : platform === 'youtube' ? 'YouTube' : 'Spotify'}</span>
      {available ? <Check size={12} /> : temporarilyUnavailable ? <span className="tag-dash">Later</span> : <span className="tag-dash">—</span>}
    </span>
  );
}

function serviceName(service?: string): string {
  if (service === 'apple') return 'Apple Music';
  if (service === 'youtube') return 'YouTube Music';
  return 'Spotify';
}

function formatDuration(milliseconds: number): string {
  const seconds = Math.floor(milliseconds / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}
