'use client';

import React, { useState, useRef, useEffect } from 'react';
import Box from '@mui/material/Box';
import IconButton from '@mui/material/IconButton';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import PauseIcon from '@mui/icons-material/Pause';
import VolumeUpIcon from '@mui/icons-material/VolumeUp';
import VolumeOffIcon from '@mui/icons-material/VolumeOff';
import FullscreenIcon from '@mui/icons-material/Fullscreen';
import ReplayIcon from '@mui/icons-material/Replay';
import CloseIcon from '@mui/icons-material/Close';
import LinearProgress from '@mui/material/LinearProgress';
import Typography from '@mui/material/Typography';
import Slider from '@mui/material/Slider';
import Tooltip from '@mui/material/Tooltip';
import CircularProgress from '@mui/material/CircularProgress';
import Alert from '@mui/material/Alert';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import ListItemIcon from '@mui/material/ListItemIcon';
import ListItemText from '@mui/material/ListItemText';
import SettingsIcon from '@mui/icons-material/Settings';
import AudiotrackIcon from '@mui/icons-material/Audiotrack';
import ClosedCaptionIcon from '@mui/icons-material/ClosedCaption';
import SubjectIcon from '@mui/icons-material/Subject';

// Import Stremio video package
// @ts-ignore TODO: Update with correct types if official ones become available
import StremioVideo from '@stremio/stremio-video';

interface VideoPlayerProps {
  url: string;
  title?: string;
  quality?: string;
  addonName?: string;
  onClose?: () => void;
  autoPlay?: boolean;
  onReadyCallback?: (player: any) => void;
  onEnded?: () => void;
}

interface TrackInfo {
  id: string;
  label: string;
  lang?: string;
  isDefault?: boolean;
}

export default function StremioVideoPlayer({
  url,
  title = 'Video',
  quality = '',
  addonName = '',
  onClose,
  autoPlay = true,
  onReadyCallback,
  onEnded,
}: VideoPlayerProps) {
  // console.log('StremioVideoPlayer: Render/Re-render. URL:', url, 'autoPlay:', autoPlay); // Commented out for less noise
  // References
  const containerRef = useRef<HTMLDivElement | null>(null);
  // @ts-ignore
  const playerRef = useRef<StremioVideo | null>(null); // Use the StremioVideo type
  const controlsTimeout = useRef<NodeJS.Timeout | null>(null);
  
  // Player state - this will largely be driven by 'propChanged' events from the player
  const [playing, setPlaying] = useState(autoPlay);
  const [volume, setVolume] = useState(0.5); // Stremio player uses 0-1 for volume
  const [muted, setMuted] = useState(false);
  const [played, setPlayed] = useState(0); // Progress percentage (0-1)
  const [duration, setDuration] = useState(0); // Seconds
  const [currentTime, setCurrentTime] = useState(0); // Seconds
  const [seeking, setSeeking] = useState(false);
  const [ready, setReady] = useState(false); // Player is ready to accept commands
  const [loaded, setLoaded] = useState(false); // Media is loaded enough to play
  const [error, setError] = useState<string | null>(null);
  const [controlsVisible, setControlsVisible] = useState(true);
  const [loading, setLoading] = useState(true); // Buffering/initial load
  const [hoverVolume, setHoverVolume] = useState(false);
  
  // Track state
  const [audioTracks, setAudioTracks] = useState<TrackInfo[]>([]);
  const [selectedAudioTrackId, setSelectedAudioTrackId] = useState<string | null>(null);
  const [subtitleTracks, setSubtitleTracks] = useState<TrackInfo[]>([]);
  const [selectedSubtitleTrackId, setSelectedSubtitleTrackId] = useState<string | null>(null);
  
  // Menu state
  const [settingsMenuAnchorEl, setSettingsMenuAnchorEl] = React.useState<null | HTMLElement>(null);
  const [audioMenuAnchorEl, setAudioMenuAnchorEl] = React.useState<null | HTMLElement>(null);
  const [subtitleMenuAnchorEl, setSubtitleMenuAnchorEl] = React.useState<null | HTMLElement>(null);

  const dispatchCommand = (commandName: string, commandArgs?: any) => {
    if (playerRef.current && containerRef.current) {
      playerRef.current.dispatch(
        { type: 'command', commandName, commandArgs }, 
        { containerElement: containerRef.current }
      );
    }
  };

  const setPlayerProp = (propName: string, propValue: any) => {
    if (playerRef.current && containerRef.current) {
      playerRef.current.dispatch(
        { type: 'setProp', propName, propValue },
        { containerElement: containerRef.current }
      );
    }
  };

  // Initialize player and load source
  useEffect(() => {
    // console.log('StremioVideoPlayer: useEffect triggered. URL:', url, 'autoPlay:', autoPlay); // Commented out for less noise
    if (!containerRef.current || !url) {
      // console.log('StremioVideoPlayer: useEffect - container or URL missing, exiting.'); // Commented out for less noise
      return;
    }

    // @ts-ignore
    playerRef.current = new StremioVideo();
    // console.log('StremioVideoPlayer: StremioVideo instance created.'); // Commented out for less noise

    const player = playerRef.current;
    let isMounted = true; // Flag to prevent state updates on unmounted component

    // Event listeners
    player.on('error', (err: any) => {
      if (!isMounted) return;
      // console.error('StremioVideoPlayer: Player error:', err); // Commented out for less noise
      setError(err.message || 'An unknown player error occurred.');
      setLoading(false);
    });

    player.on('ended', () => {
      if (!isMounted) return;
      // console.log('StremioVideoPlayer: Video ended.'); // Commented out for less noise
      setPlaying(false);
      // onEnded?.(); // Call prop if provided
    });

    player.on('propChanged', (propName: string, propValue: any) => {
      if (!isMounted) return;
      // console.log(`StremioVideoPlayer: propChanged - ${propName}:`, propValue); // Commented out for less noise, enable for debugging specific props
      switch (propName) {
        case 'paused':
          setPlaying(!propValue);
          // If video starts playing (paused is false), we can consider it loaded for spinner purposes
          if (propValue === false) setLoading(false);
          break;
        case 'volume':
          setVolume(propValue);
          break;
        case 'muted':
          setMuted(propValue);
          break;
        case 'time':
          console.log(`StremioVideoPlayer: time changed to ${propValue}`);
          // Convert from ms to seconds if needed
          const timeInSeconds = propValue !== null ? propValue / 1000 : 0;
          setCurrentTime(timeInSeconds);
          if (duration > 0) {
            setPlayed(timeInSeconds / duration);
          }
          break;
        case 'duration':
          console.log(`StremioVideoPlayer: duration changed to ${propValue}`);
          
          // Stremio appears to be reporting duration as a large number
          // Convert to seconds for display
          const durationInSeconds = propValue !== null ? propValue / 1000 : 0;
          console.log(`StremioVideoPlayer: converted duration to ${durationInSeconds} seconds`);
          
          setDuration(durationInSeconds);
          if (durationInSeconds > 0 && currentTime > 0) {
            setPlayed(currentTime / durationInSeconds);
          }
          // Having duration often means the video is loaded enough
          if (durationInSeconds > 0) setLoading(false);
          break;
        case 'buffering':
          setLoading(propValue); 
          break;
        case 'audioTracks':
          setAudioTracks((propValue || []).map((track: any) => ({
            id: track.id,
            label: track.label || track.lang || `Audio ${track.id}`,
            lang: track.lang,
            isDefault: track.default,
          })));
          break;
        case 'selectedAudioTrackId':
          setSelectedAudioTrackId(propValue);
          break;
        case 'subtitlesTracks': // Or 'textTracks'
          setSubtitleTracks((propValue || []).map((track: any) => ({
            id: track.id,
            label: track.label || track.lang || `Subtitle ${track.id}`,
            lang: track.lang,
            isDefault: track.default,
          })));
          break;
        case 'selectedSubtitlesTrackId':
          setSelectedSubtitleTrackId(propValue);
          break;
        case 'loaded': // A general 'loaded' state from the player
          setLoaded(true);
          setLoading(false);
          setReady(true);
          break;
        default:
          break;
      }
    });

    player.on('implementationChanged', (manifest: any) => {
      if (!isMounted) return;
      // console.log('StremioVideoPlayer: implementationChanged', manifest); // Commented out for less noise
      // Observe necessary properties AFTER implementation has changed
      const propsToObserve = [
        'paused', 'volume', 'muted', 'time', 'duration', 'buffering', 'loaded',
        'audioTracks', 'selectedAudioTrackId', 'subtitlesTracks', 'selectedSubtitlesTrackId',
      ];
      if (manifest && Array.isArray(manifest.props)) {
        // If manifest provides a list of observable props, use or merge with them
        // For now, using our predefined list.
        // console.log('StremioVideoPlayer: Manifest observable props:', manifest.props); // Commented out for less noise
      }
      propsToObserve.forEach(propName => {
        if (playerRef.current && containerRef.current) {
          playerRef.current.dispatch(
              { type: 'observeProp', propName }, 
              { containerElement: containerRef.current }
          );
        }
      });
      setReady(true); // Player is now more fundamentally ready
    });
    
    // Load the source
    // console.log('StremioVideoPlayer: Dispatching load command for URL:', url); // Commented out for less noise
    player.dispatch(
      {
        type: 'command',
        commandName: 'load',
        commandArgs: {
          stream: { url: url },
          autoplay: autoPlay,
          time: 0,
          forceTranscoding: false,
          maxAudioChannels: 2,
          hardwareDecoding: true,
        }
      },
      { 
        containerElement: containerRef.current,
      }
    );
    // setLoading(true); // Ensure loading is true initially when effect runs for a new source

    return () => {
      isMounted = false;
      const currentPlayerInstance = playerRef.current;
      if (currentPlayerInstance && typeof currentPlayerInstance.destroy === 'function') {
        // console.log('StremioVideoPlayer: Destroying player in useEffect cleanup.'); // Commented out for less noise
        currentPlayerInstance.destroy();
      }
      playerRef.current = null;
    };
  }, [url, autoPlay]);

  // Format time helper
  const formatTime = (seconds: number): string => {
    // Check for invalid input
    if (isNaN(seconds) || seconds === null) return '00:00';
    
    // Check if the value is extremely large - might be in milliseconds
    if (seconds > 86400 * 30) { // More than 30 days
      console.warn(`StremioVideoPlayer: Unusually large time value detected: ${seconds}s. Converting from ms to s.`);
      seconds = seconds / 1000; // Convert from ms to s if unusually large
    }
    
    const absSeconds = Math.abs(seconds);
    const hrs = Math.floor(absSeconds / 3600);
    const mins = Math.floor((absSeconds % 3600) / 60);
    const secs = Math.floor(absSeconds % 60);
    
    let timeStr = '';
    if (hrs > 0) {
      timeStr += `${hrs.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    } else {
      timeStr += `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    }
    return (seconds < 0 ? '-' : '') + timeStr;
  };

  // Controls
  const handlePlayPause = () => {
    setPlayerProp('paused', !playing);
  };

  const handleMute = () => {
    setPlayerProp('muted', !muted);
  };

  const handleVolumeChange = (_event: Event, newValue: number | number[]) => {
    const newVolume = (newValue as number) / 100; // UI slider is 0-100, player is 0-1
    setPlayerProp('volume', newVolume);
    if (newVolume > 0 && muted) {
      setPlayerProp('muted', false);
    }
  };

  const handleSeekMouseDown = () => {
    setSeeking(true);
  };

  const handleSeekChange = (_event: Event, newValue: number | number[]) => {
    setPlayed(newValue as number); // Update UI immediately
  };

  const handleSeekMouseUp = (_event: React.MouseEvent | React.TouchEvent) => {
    if (duration > 0) {
      const seekTime = played * duration;
      setPlayerProp('time', seekTime);
    }
    setSeeking(false);
  };

  // Track selection
  const handleSelectAudioTrack = (trackId: string) => {
    setPlayerProp('selectedAudioTrackId', trackId);
    handleCloseAudioMenu();
  };

  const handleSelectSubtitleTrack = (trackId: string | null) => {
    // If selecting "Off", need to know how Stremio player handles this.
    // It might be setting selectedSubtitleTrackId to null or an empty string.
    // The `useVideo.js` used `setSubtitlesTrack(null)` for this.
    // If `id` can be `null` from UI, then `setPlayerProp('selectedSubtitlesTrackId', trackId)` is fine.
    setPlayerProp('selectedSubtitlesTrackId', trackId);
    handleCloseSubtitleMenu();
  };

  // Fullscreen
  const handleFullscreen = () => {
    const container = containerRef.current;
    if (!container) return;

    if (document.fullscreenElement) {
      document.exitFullscreen().catch(err => console.error(err));
    } else {
      container.requestFullscreen().catch(err => console.error(err));
    }
  };

  // Menu handlers
  const handleOpenSettingsMenu = (event: React.MouseEvent<HTMLElement>) => {
    setSettingsMenuAnchorEl(event.currentTarget);
  };
  
  const handleCloseSettingsMenu = () => {
    setSettingsMenuAnchorEl(null);
  };

  const handleOpenAudioMenu = (event: React.MouseEvent<HTMLElement>) => {
    setAudioMenuAnchorEl(event.currentTarget);
    setSettingsMenuAnchorEl(null); // Close parent menu
  };
  
  const handleCloseAudioMenu = () => {
    setAudioMenuAnchorEl(null);
  };

  const handleOpenSubtitleMenu = (event: React.MouseEvent<HTMLElement>) => {
    setSubtitleMenuAnchorEl(event.currentTarget);
    setSettingsMenuAnchorEl(null); // Close parent menu
  };
  
  const handleCloseSubtitleMenu = () => {
    setSubtitleMenuAnchorEl(null);
  };

  // Controls visibility
  const showControls = () => {
    setControlsVisible(true);
    
    if (controlsTimeout.current) {
      clearTimeout(controlsTimeout.current);
    }
    
    controlsTimeout.current = setTimeout(() => {
      if (playing) {
        setControlsVisible(false);
      }
    }, 3000);
  };

  // Cleanup timeout on unmount
  useEffect(() => {
    return () => {
      if (controlsTimeout.current) {
        clearTimeout(controlsTimeout.current);
      }
    };
  }, []);

  // Reset controls timeout when playing state changes
  useEffect(() => {
    if (playing) {
      showControls();
    } else {
      setControlsVisible(true);
      if (controlsTimeout.current) {
        clearTimeout(controlsTimeout.current);
      }
    }
  }, [playing]);

  return (
    <Box
      ref={containerRef}
      sx={{
        position: 'relative',
        width: '100%',
        height: '100%',
        backgroundColor: 'black',
        overflow: 'hidden',
        '&:hover': { cursor: playing && !controlsVisible ? 'none' : 'default' },
      }}
      onMouseMove={showControls}
      onClick={() => {
        if (!controlsVisible) {
          showControls();
        }
      }}
    >
      {/* Loading indicator */}
      {loading && (
        <Box
          sx={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: 'rgba(0, 0, 0, 0.5)',
            zIndex: 10,
          }}
        >
          <CircularProgress color="inherit" />
        </Box>
      )}

      {/* Error message */}
      {error && (
        <Box
          sx={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 2,
            zIndex: 10,
          }}
        >
          <Alert 
            severity="error" 
            sx={{ 
              backgroundColor: 'rgba(0, 0, 0, 0.8)', 
              color: 'white',
              '.MuiAlert-icon': { color: 'white' }
            }}
          >
            {error}
          </Alert>
        </Box>
      )}

      {/* Controls overlay */}
      <Box
        sx={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          background: controlsVisible 
            ? 'linear-gradient(to top, rgba(0,0,0,0.7) 0%, transparent 20%, transparent 80%, rgba(0,0,0,0.7) 100%)'
            : 'transparent',
          opacity: controlsVisible ? 1 : 0,
          transition: 'opacity 0.3s ease',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          zIndex: 1,
        }}
      >
        {/* Top controls - title */}
        <Box 
          sx={{ 
            p: 2, 
            display: 'flex', 
            justifyContent: 'space-between',
            alignItems: 'center',
          }}
        >
          <Typography variant="subtitle1" sx={{ fontWeight: 'bold' }}>
            {title}
            {quality && (
              <Box component="span" sx={{ ml: 1, fontSize: '0.8rem', opacity: 0.8 }}>
                ({quality})
              </Box>
            )}
            {addonName && (
              <Typography variant="caption" sx={{ display: 'block', opacity: 0.7 }}>
                via {addonName}
              </Typography>
            )}
          </Typography>
          
          {onClose && (
            <IconButton 
              onClick={onClose} 
              sx={{ color: 'white' }}
            >
              <CloseIcon />
            </IconButton>
          )}
        </Box>

        {/* Bottom controls - progress, play/pause, volume, etc. */}
        <Box sx={{ p: 1.5 }}>
          {/* Progress bar */}
          <Box sx={{ mb: 1 }}>
            <Slider
              value={played * 100}
              onChange={handleSeekChange}
              onMouseDown={handleSeekMouseDown}
              onMouseUp={handleSeekMouseUp}
              sx={{
                height: 4,
                '& .MuiSlider-thumb': {
                  width: 12,
                  height: 12,
                  display: controlsVisible ? 'block' : 'none',
                  '&:hover': {
                    boxShadow: '0 0 0 8px rgba(255, 255, 255, 0.16)',
                  },
                },
                '& .MuiSlider-rail': {
                  opacity: 0.3,
                },
              }}
            />
          </Box>

          {/* Control buttons */}
          <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <Box sx={{ display: 'flex', alignItems: 'center' }}>
              {/* Play/Pause */}
              <IconButton 
                onClick={handlePlayPause}
                sx={{ color: 'white', mr: 1 }}
              >
                {playing ? <PauseIcon /> : <PlayArrowIcon />}
              </IconButton>

              {/* Volume control */}
              <Box
                sx={{ 
                  display: 'flex', 
                  alignItems: 'center', 
                  position: 'relative',
                  '&:hover': { '& .volume-slider': { width: 100, opacity: 1 } }
                }}
                onMouseEnter={() => setHoverVolume(true)}
                onMouseLeave={() => setHoverVolume(false)}
              >
                <IconButton 
                  onClick={handleMute}
                  sx={{ color: 'white', mr: 1 }}
                >
                  {muted || volume === 0 ? <VolumeOffIcon /> : <VolumeUpIcon />}
                </IconButton>
                
                <Box 
                  className="volume-slider"
                  sx={{ 
                    width: hoverVolume ? 100 : 0, 
                    opacity: hoverVolume ? 1 : 0,
                    transition: 'width 0.2s ease, opacity 0.2s ease',
                    overflow: 'hidden',
                  }}
                >
                  <Slider
                    value={volume * 100}
                    onChange={(e, v) => handleVolumeChange(e, (v as number))}
                    sx={{
                      color: 'white',
                      height: 4,
                      '& .MuiSlider-rail': { opacity: 0.3 },
                      '& .MuiSlider-thumb': { width: 10, height: 10 },
                    }}
                  />
                </Box>
              </Box>

              {/* Time display */}
              <Typography variant="body2" sx={{ ml: 2, color: 'white' }}>
                {formatTime(currentTime)} / {formatTime(duration)}
              </Typography>
            </Box>

            {/* Right-side controls */}
            <Box>
              {/* Fullscreen button */}
              <IconButton 
                onClick={handleFullscreen}
                sx={{ color: 'white' }}
              >
                <FullscreenIcon />
              </IconButton>

              {/* Settings Button for Audio/Subtitle Tracks */}
              {(audioTracks.length > 0 || subtitleTracks.length > 0) && (
                <IconButton
                  onClick={handleOpenSettingsMenu}
                  sx={{ color: 'white' }}
                >
                  <SettingsIcon />
                </IconButton>
              )}
            </Box>
          </Box>
        </Box>
      </Box>

      {/* Settings Menu */}
      <Menu
        anchorEl={settingsMenuAnchorEl}
        open={Boolean(settingsMenuAnchorEl)}
        onClose={handleCloseSettingsMenu}
      >
        {audioTracks.length > 0 && (
          <MenuItem onClick={handleOpenAudioMenu}>
            <ListItemIcon>
              <AudiotrackIcon fontSize="small" />
            </ListItemIcon>
            <ListItemText>Audio Tracks</ListItemText>
          </MenuItem>
        )}
        {subtitleTracks.length > 0 && (
          <MenuItem onClick={handleOpenSubtitleMenu}>
            <ListItemIcon>
              <ClosedCaptionIcon fontSize="small" />
            </ListItemIcon>
            <ListItemText>Subtitles</ListItemText>
          </MenuItem>
        )}
      </Menu>

      {/* Audio Tracks Menu */}
      <Menu
        anchorEl={audioMenuAnchorEl}
        open={Boolean(audioMenuAnchorEl)}
        onClose={handleCloseAudioMenu}
      >
        {audioTracks.map((track) => (
          <MenuItem
            key={track.id}
            selected={track.id === selectedAudioTrackId}
            onClick={() => handleSelectAudioTrack(track.id)}
          >
            {track.label}
          </MenuItem>
        ))}
      </Menu>

      {/* Subtitle Tracks Menu */}
      <Menu
        anchorEl={subtitleMenuAnchorEl}
        open={Boolean(subtitleMenuAnchorEl)}
        onClose={handleCloseSubtitleMenu}
      >
        <MenuItem
          selected={selectedSubtitleTrackId === null}
          onClick={() => handleSelectSubtitleTrack(null)}
        >
          Off
        </MenuItem>
        {subtitleTracks.map((track) => (
          <MenuItem
            key={track.id}
            selected={track.id === selectedSubtitleTrackId}
            onClick={() => handleSelectSubtitleTrack(track.id)}
          >
            {track.label}{track.isDefault ? ' (default)' : ''}
          </MenuItem>
        ))}
      </Menu>
    </Box>
  );
} 