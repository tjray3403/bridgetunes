import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { submitPlaylist } from '../services/api';
import { completeSpotifyAuthorization } from '../services/spotifyAuth';
import { ArrowLeft, CheckCircle2, Loader2, Music2 } from 'lucide-react';

type PendingPlaylist = { url: string; service: string };

export function SpotifyCallback() {
  const navigate = useNavigate();
  const [error, setError] = useState('');
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
      const result = await submitPlaylist(pending.url, pending.service, accessToken);
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
            <h1>Connecting your music…</h1>
            <p className="state-copy">Spotify is connected. We’re bringing your playlist back to BridgeTunes.</p>
            <span className="callback-secure"><CheckCircle2 size={14} /> Secure sign-in with Spotify</span>
          </div>
      )}
      </div>
    </main>
  );
}
