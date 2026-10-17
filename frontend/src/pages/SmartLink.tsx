import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { AlertCircle, ArrowLeft, Check, CheckCircle2, Clipboard, Loader2, Music2, Sparkles } from 'lucide-react';
import { getPlaylist, trackPlaylistVisit } from '../services/api';
import { currentSpotifyAccessToken, spotifyAuthorizationUrl } from '../services/spotifyAuth';
import { createSpotifyPlaylist, type SpotifyCreationProgress } from '../services/spotifyPlaylist';

type PlaylistTrack = {
  id?: string;
  title?: string;
  artist?: string;
  durationMs?: number;
  availability?: { spotify?: string | null; apple?: string | null };
};

type PlaylistData = {
  name?: string;
  status?: string;
  sourceService?: string;
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
  const visitTrackedFor = useRef<string | null>(null);

  useEffect(() => {
    if (!id || visitTrackedFor.current === id) return;
    visitTrackedFor.current = id;
    void trackPlaylistVisit(id).catch(() => undefined);
  }, [id]);

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

  const copyShareLink = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setShareMessage('Link copied. Anyone with it can view this playlist.');
    } catch {
      setShareMessage('Could not copy automatically. Copy the page address from your browser.');
    }
  };

  const createInSpotify = async () => {
    if (!isReady || spotifyTrackUris.length === 0 || spotifyBusy) return;
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
              {spotifyPlaylistUrl ? (
                <a className="button button-primary" href={spotifyPlaylistUrl} target="_blank" rel="noreferrer"><Music2 size={15} /> Open in Spotify</a>
              ) : (
                <button type="button" className="button button-primary" onClick={() => void createInSpotify()} disabled={!isReady || spotifyTrackUris.length === 0 || spotifyBusy}>
                  {spotifyBusy ? <Loader2 className="spin" size={15} /> : <Music2 size={15} />}
                  {spotifyBusy ? 'Creating playlist…' : 'Create in Spotify'}
                </button>
              )}
            </div>
            {spotifyBusy && spotifyProgress && <SpotifyProgress progress={spotifyProgress} />}
            {isReady && spotifyTrackUris.length === 0
              ? <p className="share-action-message" role="status">No Spotify track matches are available for this link yet.</p>
              : <p className="share-action-help">Spotify will ask you to approve creating a private playlist with the matched tracks.</p>}
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
            <span><i className="legend-dot legend-spotify" /> Spotify</span>
            <span><i className="legend-dot legend-apple" /> Apple Music</span>
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
                    <AvailabilityTag platform="spotify" available={Boolean(track.availability?.spotify)} />
                    <AvailabilityTag platform="apple" available={Boolean(track.availability?.apple)} />
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

function AvailabilityTag({ platform, available }: { platform: 'spotify' | 'apple'; available: boolean }) {
  return (
    <span className={`availability-tag ${available ? `tag-${platform}-available` : ''}`} aria-label={`${serviceName(platform)} ${available ? 'available' : 'not found'}`}>
      <i className={`tag-dot tag-dot-${platform}`} />
      <span className="tag-label">{platform === 'apple' ? 'Apple' : 'Spotify'}</span>
      {available ? <Check size={12} /> : <span className="tag-dash">—</span>}
    </span>
  );
}

function serviceName(service?: string): string {
  if (service === 'apple') return 'Apple Music';
  return 'Spotify';
}

function formatDuration(milliseconds: number): string {
  const seconds = Math.floor(milliseconds / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}
