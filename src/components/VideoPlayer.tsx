'use client';

import React, { useState, useRef, useEffect } from 'react';
import ReactPlayer from 'react-player';
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

interface VideoPlayerProps {
  url: string;
  title?: string;
  quality?: string;
  addonName?: string;
  onClose?: () => void;
  autoPlay?: boolean;
}

export default function VideoPlayer({
  url,
  title = 'Video',
  quality = '',
  addonName = '',
  onClose,
  autoPlay = true,
}: VideoPlayerProps) {
  // Player state
  const [playing, setPlaying] = useState(autoPlay);
  const [volume, setVolume] = useState(0.5);
  const [muted, setMuted] = useState(false);
  const [played, setPlayed] = useState(0);
  const [duration, setDuration] = useState(0);
  const [seeking, setSeeking] = useState(false);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [controlsVisible, setControlsVisible] = useState(true);
  const [loading, setLoading] = useState(true);
  const [hoverVolume, setHoverVolume] = useState(false);

  // State for audio and subtitle tracks
  interface TrackInfo {
    id: number; // Index for HTML5 tracks, or original ID for HLS tracks if numeric
    label: string;
    language?: string;
    kind?: string; // For text tracks (e.g., 'subtitles', 'captions') or HLS type
    originalId?: string | number; // Original id from the track object (can be string or number)
    isDefault?: boolean;
  }

  const [audioTracks, setAudioTracks] = useState<TrackInfo[]>([]);
  const [selectedAudioTrack, setSelectedAudioTrack] = useState<number>(-1);
  const [subtitleTracks, setSubtitleTracks] = useState<TrackInfo[]>([]);
  const [selectedSubtitleTrack, setSelectedSubtitleTrack] = useState<number>(-1); // -1 for off

  // State for menus
  const [settingsMenuAnchorEl, setSettingsMenuAnchorEl] = React.useState<null | HTMLElement>(null);
  const [audioMenuAnchorEl, setAudioMenuAnchorEl] = React.useState<null | HTMLElement>(null);
  const [subtitleMenuAnchorEl, setSubtitleMenuAnchorEl] = React.useState<null | HTMLElement>(null);

  // References
  const playerRef = useRef<ReactPlayer | null>(null);
  const playerContainerRef = useRef<HTMLDivElement | null>(null);
  const controlsTimeout = useRef<NodeJS.Timeout | null>(null);
  
  // Format time (seconds to MM:SS or HH:MM:SS)
  const formatTime = (seconds: number): string => {
    if (isNaN(seconds)) return '00:00';
    
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    
    if (hours > 0) {
      return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    }
    
    return `${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  // Handle player ready event
  const handleReady = () => {
    setReady(true);
    setLoading(false);
    console.log('VideoPlayer: Player is ready.');

    const player = playerRef.current;
    if (player) {
      const internalPlayer = player.getInternalPlayer();
      console.log('VideoPlayer: Internal player instance:', internalPlayer);

      const processTracks = () => {
        if (internalPlayer && internalPlayer instanceof HTMLVideoElement) {
          console.log('VideoPlayer: HTMLVideoElement instance found.');
          const videoElement = internalPlayer as HTMLVideoElement;

          // Process Audio Tracks
          const newAudioTracks: TrackInfo[] = [];
          let currentAudioTrackIndex = -1;
          // @ts-ignore - Linter workaround for audioTracks property
          const audioTrackList = videoElement['audioTracks'];
          if (audioTrackList && typeof audioTrackList.length === 'number') {
            for (let i = 0; i < audioTrackList.length; i++) {
              const track = audioTrackList[i];
              newAudioTracks.push({
                id: i, // Use index as the selection ID
                label: track.label || track.language || `Audio ${i + 1}`,
                language: track.language,
                originalId: track.id, // HTML AudioTrack .id is a string
              });
              if (track.enabled) {
                currentAudioTrackIndex = i;
              }
            }
            console.log('VideoPlayer: Processed HTML5 audio tracks:', newAudioTracks);
            setAudioTracks(newAudioTracks);
            setSelectedAudioTrack(currentAudioTrackIndex !== -1 ? currentAudioTrackIndex : (newAudioTracks.length > 0 ? 0 : -1));
          } else {
            console.log('VideoPlayer: videoElement.audioTracks not available or not a list.');
            setAudioTracks([]);
            setSelectedAudioTrack(-1);
          }

          // Process Subtitle Tracks (TextTracks)
          const newSubtitleTracks: TrackInfo[] = [];
          let currentSubtitleTrackIndex = -1;
          // @ts-ignore - Linter workaround for textTracks property
          const textTrackList = videoElement['textTracks'];
          if (textTrackList && typeof textTrackList.length === 'number') {
            for (let i = 0; i < textTrackList.length; i++) {
              const track = textTrackList[i];
              if (track.kind === 'subtitles' || track.kind === 'captions' || track.kind === 'descriptions') {
                newSubtitleTracks.push({
                  id: i, // Use index as the selection ID
                  label: track.label || track.language || `Subtitle ${i + 1}`,
                  language: track.language,
                  kind: track.kind,
                  originalId: track.id, // HTML TextTrack .id is a string
                });
                if (track.mode === 'showing') {
                  currentSubtitleTrackIndex = i;
                }
              }
            }
            console.log('VideoPlayer: Processed HTML5 subtitle tracks:', newSubtitleTracks);
            setSubtitleTracks(newSubtitleTracks);
            setSelectedSubtitleTrack(currentSubtitleTrackIndex); 
          } else {
            console.log('VideoPlayer: videoElement.textTracks not available or not a list.');
            setSubtitleTracks([]);
            setSelectedSubtitleTrack(-1);
          }

        } else { 
          // @ts-ignore
          if (internalPlayer && typeof internalPlayer.audioTracks !== 'undefined') {
            // @ts-ignore // Assuming HLS.js like player
            const hlsPlayer = internalPlayer;
            console.log('VideoPlayer: HLS.js-like instance found (fallback).', hlsPlayer);
            
            const hlsAudioTracks: TrackInfo[] = (hlsPlayer.audioTracks || []).map((track: any, index: number) => ({
              id: typeof track.id === 'number' ? track.id : index, // Prefer HLS track.id if it's a number, else use index
              label: track.name || track.lang || `Audio ${index + 1}`,
              language: track.lang,
              kind: track.type, // HLS audio tracks might have a 'type' property
              originalId: track.id, 
              isDefault: track.default,
            }));
            setAudioTracks(hlsAudioTracks);
            // @ts-ignore
            const currentHlsAudioTrackId = hlsPlayer.audioTrack;
            const selectedHlsAudio = hlsAudioTracks.find(t => t.id === currentHlsAudioTrackId);
            setSelectedAudioTrack(selectedHlsAudio ? selectedHlsAudio.id : (hlsAudioTracks.length > 0 ? hlsAudioTracks[0].id : -1));
            
            const hlsSubtitleTracks: TrackInfo[] = (hlsPlayer.subtitleTracks || []).map((track: any, index: number) => ({
                id: typeof track.id === 'number' ? track.id : index, 
                label: track.name || track.lang || `Subtitle ${index + 1}`,
                language: track.lang,
                kind: track.type, // HLS subtitle tracks might have a 'type'
                originalId: track.id,
                isDefault: track.default,
            }));
            setSubtitleTracks(hlsSubtitleTracks);
            // @ts-ignore
            const currentHlsSubtitleTrackId = hlsPlayer.subtitleTrack;
            const selectedHlsSubtitle = hlsSubtitleTracks.find(t => t.id === currentHlsSubtitleTrackId);
            setSelectedSubtitleTrack(selectedHlsSubtitle ? selectedHlsSubtitle.id : -1); 

            console.log('VideoPlayer: HLS audioTracks:', hlsAudioTracks, 'Selected:', selectedAudioTrack);
            console.log('VideoPlayer: HLS subtitleTracks:', hlsSubtitleTracks, 'Selected:', selectedSubtitleTrack);
          } else {
            console.log('VideoPlayer: Not an HTMLVideoElement or HLS.js-like instance, or tracks not available.');
            setAudioTracks([]);
            setSubtitleTracks([]);
            setSelectedAudioTrack(-1);
            setSelectedSubtitleTrack(-1);
          }
        }
      };
      
      processTracks(); // Initial processing

      // Add event listeners for HTMLVideoElement tracks
      if (internalPlayer && internalPlayer instanceof HTMLVideoElement) {
        const videoElement = internalPlayer as HTMLVideoElement;
        // @ts-ignore - Linter workaround
        const currentAudioTracks = videoElement['audioTracks'];
        // @ts-ignore - Linter workaround
        const currentTextTracks = videoElement['textTracks'];

        if (currentAudioTracks) {
          currentAudioTracks.onaddtrack = processTracks;
          currentAudioTracks.onremovetrack = processTracks;
          currentAudioTracks.onchange = processTracks; 
        }
        if (currentTextTracks) {
          currentTextTracks.onaddtrack = processTracks;
          currentTextTracks.onremovetrack = processTracks;
          currentTextTracks.onchange = processTracks; 
        }
      }

    } else {
      console.log('VideoPlayer: playerRef.current is null in handleReady.');
    }
  };

  // Menu open/close handlers
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

  // Track selection handlers
  const handleSelectAudioTrack = (trackId: number) => {
    const player = playerRef.current?.getInternalPlayer();
    if (!player) return;

    if (player instanceof HTMLVideoElement) {
      // @ts-ignore - Linter workaround
      const audioTrackList = player['audioTracks'];
      if (audioTrackList) {
        for (let i = 0; i < audioTrackList.length; i++) {
          // trackId here is the index for HTMLVideoElement tracks
          audioTrackList[i].enabled = (i === trackId);
        }
        setSelectedAudioTrack(trackId);
      }
    } else {
      // Assuming HLS.js or similar player where trackId is the actual track ID
      // @ts-ignore
      if (player && typeof player.audioTracks !== 'undefined') {
        // @ts-ignore
        player.audioTrack = trackId;
        setSelectedAudioTrack(trackId);
      }
    }
    handleCloseAudioMenu();
  };

  const handleSelectSubtitleTrack = (trackId: number) => {
    const player = playerRef.current?.getInternalPlayer();
    if (!player) return;

    if (player instanceof HTMLVideoElement) {
      // @ts-ignore - Linter workaround
      const textTrackList = player['textTracks'];
      if (textTrackList) {
        for (let i = 0; i < textTrackList.length; i++) {
          // trackId here is the index for HTMLVideoElement tracks, or -1 for Off
          if (trackId === -1) {
            textTrackList[i].mode = 'disabled';
          } else {
            textTrackList[i].mode = (i === trackId) ? 'showing' : 'disabled';
          }
        }
        setSelectedSubtitleTrack(trackId);
      }
    } else {
      // Assuming HLS.js or similar player where trackId is the actual track ID, or -1 for Off
      // @ts-ignore
      if (player && typeof player.subtitleTracks !== 'undefined') {
        // @ts-ignore
        player.subtitleTrack = trackId;
        setSelectedSubtitleTrack(trackId);
      }
    }
    handleCloseSubtitleMenu();
  };

  // Handle play/pause toggle
  const handlePlayPause = () => {
    setPlaying(!playing);
  };

  // Handle mute toggle
  const handleMute = () => {
    setMuted(!muted);
  };

  // Handle volume change
  const handleVolumeChange = (_event: Event, newValue: number | number[]) => {
    setVolume(newValue as number);
    if (newValue === 0) {
      setMuted(true);
    } else {
      setMuted(false);
    }
  };

  // Handle seeking
  const handleSeekMouseDown = () => {
    setSeeking(true);
  };

  const handleSeekChange = (_event: Event, newValue: number | number[]) => {
    setPlayed(newValue as number);
  };

  const handleSeekMouseUp = (_event: React.MouseEvent | React.TouchEvent) => {
    setSeeking(false);
    if (playerRef.current) {
      playerRef.current.seekTo(played);
    }
  };

  // Handle progress updates
  const handleProgress = (state: { played: number; playedSeconds: number; loaded: number; loadedSeconds: number }) => {
    if (!seeking) {
      setPlayed(state.played);
    }
  };

  // Handle fullscreen toggle
  const handleFullscreen = () => {
    const container = playerContainerRef.current;
    if (!container) return;

    if (document.fullscreenElement) {
      document.exitFullscreen().catch(err => console.error(err));
    } else {
      container.requestFullscreen().catch(err => console.error(err));
    }
  };

  // Handle error
  const handleError = (error: any) => {
    console.error('Player error:', error);
    setError('Failed to load video. The stream may be unavailable or in an unsupported format.');
    setLoading(false);
  };

  // Show/hide controls based on mouse movement
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

  // Clean up timeout on unmount
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

  // Cleanup effect for event listeners
  useEffect(() => {
    const player = playerRef.current;
    if (player) {
      const internalPlayer = player.getInternalPlayer();
      if (internalPlayer && internalPlayer instanceof HTMLVideoElement) {
        const videoElement = internalPlayer as HTMLVideoElement;
        
        // The processTracks function is defined within handleReady and assigned to onaddtrack etc.
        // The cleanup sets these .on<event> handlers to null.

        // @ts-ignore - Linter workaround for audioTracks property
        const audioTrackRef = videoElement['audioTracks']; 
        // @ts-ignore - Linter workaround for textTracks property
        const textTrackRef = videoElement['textTracks'];

        return () => {
          if (audioTrackRef) {
            audioTrackRef.onaddtrack = null;
            audioTrackRef.onremovetrack = null;
            audioTrackRef.onchange = null;
          }
          if (textTrackRef) {
            textTrackRef.onaddtrack = null;
            textTrackRef.onremovetrack = null;
            textTrackRef.onchange = null;
          }
          console.log("VideoPlayer: Cleaned up track event listeners.");
        };
      }
    }
  }, [playerRef]); 

  return (
    <Box
      ref={playerContainerRef}
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
      {/* Video player */}
      <ReactPlayer
        ref={playerRef}
        url={url}
        width="100%"
        height="100%"
        playing={playing}
        volume={volume}
        muted={muted}
        onReady={handleReady}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onProgress={handleProgress}
        onDuration={setDuration}
        onError={handleError}
        config={{
          file: {
            forceVideo: true,
            attributes: {
              controlsList: 'nodownload',
            }
          }
        }}
        style={{ position: 'absolute', top: 0, left: 0 }}
      />

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
                    onChange={(e, v) => handleVolumeChange(e, (v as number) / 100)}
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
                {formatTime(played * duration)} / {formatTime(duration)}
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
            selected={track.id === selectedAudioTrack}
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
          selected={selectedSubtitleTrack === -1}
          onClick={() => handleSelectSubtitleTrack(-1)}
        >
          Off
        </MenuItem>
        {subtitleTracks.map((track) => (
          <MenuItem
            key={track.id} 
            selected={track.id === selectedSubtitleTrack}
            onClick={() => handleSelectSubtitleTrack(track.id)}
          >
            {track.label}{track.isDefault ? ' (default)' : ''}
          </MenuItem>
        ))}
      </Menu>
    </Box>
  );
}