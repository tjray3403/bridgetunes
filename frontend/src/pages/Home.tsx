import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { submitPlaylist } from '../services/api';
import { Music, ArrowRight, Loader2 } from 'lucide-react';

export function Home() {
  const [url, setUrl] = useState('');
  const [service, setService] = useState('spotify');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const navigate = useNavigate();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!url.trim()) return;

    setLoading(true);
    setError('');

    try {
      const data = await submitPlaylist(url, service);
      navigate(`/p/${data.playlistId}`);
    } catch (err: any) {
      setError(axiosErrorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-950 text-white flex flex-col items-center justify-center p-6">
      <div className="max-w-xl w-full bg-slate-900 border border-slate-800 rounded-2xl p-8 shadow-2xl">
        <div className="flex items-center space-x-3 mb-6">
          <div className="p-3 bg-violet-600/20 text-violet-400 rounded-xl">
            <Music size={28} />
          </div>
          <div>
            <h1 className="text-2xl font-bold tracking-tight">BridgeTunes</h1>
            <p className="text-sm text-slate-400">Transfer playlists across music platforms instantly.</p>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">
              Select Source Service
            </label>
            <select
              value={service}
              onChange={(e) => setService(e.target.value)}
              className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-violet-500 transition-colors"
            >
              <option value="spotify">Spotify</option>
              <option value="apple">Apple Music</option>
            </select>
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">
              Playlist URL
            </label>
            <input
              type="url"
              placeholder="https://open.spotify.com/playlist/..."
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              required
              className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-3 text-white placeholder-slate-600 focus:outline-none focus:border-violet-500 transition-colors"
            />
          </div>

          {error && <p className="text-sm text-red-400">{error}</p>}

          <button
            type="submit"
            disabled={loading}
            className="w-full bg-violet-600 hover:bg-violet-500 font-semibold py-3 px-4 rounded-xl transition-all flex items-center justify-center space-x-2 disabled:opacity-50"
          >
            {loading ? (
              <>
                <Loader2 className="animate-spin" size={20} />
                <span>Processing Link...</span>
              </>
            ) : (
              <>
                <span>Generate Smart Link</span>
                <ArrowRight size={20} />
              </>
            )}
          </button>
        </form>
      </div>
    </div>
  );
}

function axiosErrorMessage(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'response' in error) {
    const response = (error as { response?: { data?: { error?: string } } }).response;
    if (response?.data?.error) return response.data.error;
  }
  return 'Failed to submit playlist. Please try again.';
}
