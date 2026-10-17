import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { submitPlaylist } from '../services/api';
import { completeSpotifyAuthorization } from '../services/spotifyAuth';
import { createSpotifyPlaylist, type SpotifyCreationProgress } from '../services/spotifyPlaylist';
import { ArrowLeft, CheckCircle2, Loader2, Music2 } from 'lucide-react';

type PendingPlaylist =
  | { mode?: 'import'; url: string; service: string; playlistName?: string; expiresInHours?: number; expiresInDays?: number }
  | { mode: 'create'; name: string; trackUris: string[] };

export function SpotifyCallback() {
  const navigate = useNavigate();
  const [error, setError] = useState('');
  const [createdPlaylistUrl, setCreatedPlaylistUrl] = useState('');
  const [creationProgress, setCreationProgress] = useState<SpotifyCreationProgress | null>(null);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;

    const finish = async () => {
      const params = new URLSearchParams(window.location.search);
      if (params.has('error')) throw new Error('Spotify sign-in was cancelled or denied.');
      const code = params.get('code');
      if (!code) throw new Error('Spotify did not return an authorization code.');

      const accessToken = await completeSpotifyAuthorization(code, params.get('state'));
      const pendingValue = sessionStorage.getItem('bridgetunes-pending-playlist');
      if (!pendingValue) {
        navigate('/', { replace: true });
        return;
      }

      const pending = JSON.parse(pendingValue) as PendingPlaylist;
      if (pending.mode === 'create') {
        const spotifyUrl = await createSpotifyPlaylist(accessToken, pending.name, pending.trackUris, setCreationProgress);
        sessionStorage.removeItem('bridgetunes-pending-playlist');
        setCreatedPlaylistUrl(spotifyUrl);
        return;
      }
      const expirationHours = pending.expiresInHours ?? (pending.expiresInDays ?? 1) * 24;
      const result = await submitPlaylist(pending.url, pending.service, accessToken, expirationHours, pending.playlistName);
      sessionStorage.removeItem('bridgetunes-pending-playlist');
      navigate(`/p/${result.playlistId}`, { replace: true });
    };

    finish().catch((cause: unknown) => {
      sessionStorage.removeItem('bridgetunes-pending-playlist');
      setError(cause instanceof Error ? cause.message : 'Could not finish Spotify sign-in.');
    });
  }, [navigate]);

  return (
    <main className="site-shell state-shell callback-shell">
      <div className="ambient ambient-gold" aria-hidden="true" />
      <div className="state-card callback-card">
        <span className={`state-icon ${error ? 'state-icon-error' : 'state-icon-gold'}`}>
          {error ? <Music2 size={22} /> : <Loader2 className="spin" size={22} />}
        </span>
        <p className="eyebrow">SPOTIFY CONNECTION</p>
      {error ? (
          <div role="alert" className="callback-message">
            <h1>We couldn’t connect Spotify.</h1>
            <p className="state-copy">{error}</p>
            <Link className="button button-primary" to="/"><ArrowLeft size={16} /> Return to BridgeTunes</Link>
          </div>
      ) : (
          <div className="callback-message" aria-live="polite">
            {createdPlaylistUrl ? (
              <>
                <h1>Your Spotify playlist is ready.</h1>
                <p className="state-copy">BridgeTunes created a private playlist with the tracks that matched on Spotify.</p>
                <a className="button button-primary" href={createdPlaylistUrl} target="_blank" rel="noreferrer">Open in Spotify <Music2 size={16} /></a>
              </>
            ) : <>
            <h1>{creationProgress ? 'Creating your Spotify playlist…' : 'Connecting your music…'}</h1>
            <p className="state-copy">{creationProgress ? (creationProgress.stage === 'creating' ? 'Creating your private playlist.' : `Adding tracks: ${creationProgress.completed} of ${creationProgress.total} batches complete.`) : 'Spotify is connected. We’re bringing your playlist back to BridgeTunes.'}</p>
            {creationProgress && <SpotifyProgress progress={creationProgress} />}
            <span className="callback-secure"><CheckCircle2 size={14} /> Secure sign-in with Spotify</span>
            </>}
          </div>
      )}
      </div>
    </main>
  );
}

function SpotifyProgress({ progress }: { progress: SpotifyCreationProgress }) {
  const percent = progress.stage === 'creating'
    ? 8
    : 10 + Math.round((progress.completed / Math.max(progress.total, 1)) * 90);
  return <div className="spotify-create-progress callback-progress" aria-live="polite">
    <div className="progress-track" role="progressbar" aria-label="Spotify playlist creation progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
      <span style={{ width: `${percent}%` }} />
    </div>
  </div>;
}
