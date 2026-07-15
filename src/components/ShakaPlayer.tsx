'use client';

import React, { useEffect, useRef, useState } from 'react';
import { Box, IconButton, Typography, CircularProgress } from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import { parseClearKeyUrl } from '@/lib/clearkey';

interface ShakaPlayerProps {
  url: string;
  title?: string;
  quality?: string;
  addonName?: string;
  onClose?: () => void;
  autoPlay?: boolean;
}

/**
 * DASH/HLS player with on-device ClearKey (EME) decryption via Shaka Player.
 *
 * Used for streams whose URL carries a `#clearkey=<kid>:<key>` fragment — decryption
 * happens in the browser's CDM, so no server-side decryption proxy is required. Works
 * in Chromium/Firefox and on webOS/Tizen TV browsers, which support the ClearKey CDM.
 */
export default function ShakaPlayer({
  url,
  title = 'Video',
  onClose,
  autoPlay = true,
}: ShakaPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let destroyed = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let player: any = null;
    const video = videoRef.current;
    if (!video) return;

    const { playbackUrl, clearKeys } = parseClearKeyUrl(url);

    (async () => {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const shaka: any = (await import('shaka-player/dist/shaka-player.compiled.js')).default;
        if (destroyed) return;

        shaka.polyfill.installAll();
        if (!shaka.Player.isBrowserSupported()) {
          setError('This browser cannot play DRM-protected streams.');
          setLoading(false);
          return;
        }

        player = new shaka.Player();
        await player.attach(video);
        if (destroyed) {
          await player.destroy();
          return;
        }

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        player.addEventListener('error', (event: any) => {
          const code = event?.detail?.code ?? 'unknown';
          setError(`Playback error (${code}).`);
        });

        if (clearKeys) {
          player.configure({ drm: { clearKeys } });
        }

        await player.load(playbackUrl);
        if (destroyed) return;
        setLoading(false);
        if (autoPlay) {
          video.play().catch(() => {
            /* autoplay may be blocked until user interaction */
          });
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } catch (e: any) {
        if (destroyed) return;
        const code = e?.code ?? e?.message ?? 'unknown';
        setError(`Failed to load stream (${code}).`);
        setLoading(false);
      }
    })();

    return () => {
      destroyed = true;
      if (player) {
        player.destroy().catch(() => undefined);
      }
    };
  }, [url, autoPlay]);

  return (
    <Box sx={{ position: 'relative', width: '100%', height: '100%', bgcolor: 'black' }}>
      <video
        ref={videoRef}
        controls
        autoPlay={autoPlay}
        playsInline
        style={{ width: '100%', height: '100%', objectFit: 'contain', background: 'black' }}
      />

      <Box
        sx={{
          position: 'absolute',
          top: 8,
          left: 16,
          right: 16,
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          pointerEvents: 'none',
        }}
      >
        <Typography
          variant="subtitle1"
          noWrap
          sx={{ color: 'white', textShadow: '0 1px 3px rgba(0,0,0,0.8)', maxWidth: '80%' }}
        >
          {title}
        </Typography>
        {onClose && (
          <IconButton onClick={onClose} sx={{ color: 'white', pointerEvents: 'auto' }} aria-label="Close">
            <CloseIcon />
          </IconButton>
        )}
      </Box>

      {loading && !error && (
        <CircularProgress
          sx={{ position: 'absolute', top: '50%', left: '50%', mt: '-20px', ml: '-20px', color: 'white' }}
        />
      )}

      {error && (
        <Typography
          sx={{
            position: 'absolute',
            top: '50%',
            left: '50%',
            transform: 'translate(-50%, -50%)',
            color: '#ff6b6b',
            textAlign: 'center',
            px: 2,
          }}
        >
          {error}
        </Typography>
      )}
    </Box>
  );
}
