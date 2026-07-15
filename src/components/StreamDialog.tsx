'use client';

import React, { useState, useEffect, useCallback } from 'react';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import CircularProgress from '@mui/material/CircularProgress';
import Button from '@mui/material/Button';
import Alert from '@mui/material/Alert';
import List from '@mui/material/List';
import ListItem from '@mui/material/ListItem';
import ListItemText from '@mui/material/ListItemText';
import ListItemIcon from '@mui/material/ListItemIcon';
import Divider from '@mui/material/Divider';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import PublicIcon from '@mui/icons-material/Public';
import HdIcon from '@mui/icons-material/Hd';
import SdIcon from '@mui/icons-material/Sd';
import VideocamIcon from '@mui/icons-material/Videocam';
import FormControl from '@mui/material/FormControl';
import Select from '@mui/material/Select';
import MenuItem from '@mui/material/MenuItem';
import InputLabel from '@mui/material/InputLabel';
import IconButton from '@mui/material/IconButton';
import CloseIcon from '@mui/icons-material/Close';
import { TransitionProps } from '@mui/material/transitions';
import Collapse from '@mui/material/Collapse';
import { useTmdbContext } from '@/context/TmdbContext'; // Import TMDB context
import dynamic from 'next/dynamic';
import { useAddonContext } from '@/context/AddonContext'; // Import AddonContext

// Import VideoPlayerWrapper with SSR disabled (was VideoPlayer)
const VideoPlayerWrapper = dynamic(() => import('./VideoPlayerWrapper'), { ssr: false });

// Interfaces (Copied from stream page)
interface Stream {
  name: string;
  title?: string;
  url: string;
  description?: string;
  behaviorHints?: {
    videoSize?: number;
    filename?: string;
    [key: string]: any;
  };
  behindProxy?: boolean;
  external?: boolean;
  ytId?: string;
  externalUrl?: string;
  addon: string;
  addonName: string;
  quality?: string | null;
  resolution?: string;
  size?: string;
  source?: string;
  format?: string;
  codec?: string;
  audio?: string;
  hdr?: boolean;
  dv?: boolean;
  language?: string;
  release_group?: string;
  is10bit?: boolean;      // Added for 10-bit video information
  cachedInfo?: string;   // Added for caching provider information (e.g., "Cached on RD, AD")
}

interface StreamResponse {
  streams?: Stream[];
  addon?: string;
  error?: string;
}

// Component Props
interface StreamDialogProps {
  open: boolean;
  onClose: () => void;
  contentType: string;
  contentId: string;
  season?: number | null;
  episode?: number | null;
  contentName?: string;
  episodeInfo?: string;
  initialAddonId?: string | null;
  TransitionComponent?: React.ComponentType<
    TransitionProps & {
      children: React.ReactElement<any, any>;
    }
  >;
  keepMounted?: boolean;
}

export default function StreamDialog({
  open,
  onClose,
  contentType,
  contentId,
  season,
  episode,
  contentName = 'Content',
  episodeInfo = '',
  initialAddonId,
  TransitionComponent,
  keepMounted,
}: StreamDialogProps) {
  const [streams, setStreams] = useState<Stream[]>([]);
  const [loading, setLoading] = useState(false); // Start as false, fetch on open
  const [error, setError] = useState<string | null>(null);
  const [selectedAddon, setSelectedAddon] = useState<string | null>(null);
  const [conversionError, setConversionError] = useState<string | null>(null); // For ID conversion errors
  const [selectedStream, setSelectedStream] = useState<Stream | null>(null); // New state for the selected stream

  const { tmdbApiKey } = useTmdbContext(); // Get TMDB API key
  const { 
    installedAddons, 
    isLoading: addonsLoading, 
    isStreamingAddon,  // Get the new helper
    installSampleAddon // Get the sample addon installer
  } = useAddonContext(); // Get addons from context

  // Log when component renders with current addon state
  useEffect(() => {
    console.log('StreamDialog: Component rendered with addons:', 
      addonsLoading ? 'loading...' : `${installedAddons?.length || 0} addons loaded`);
    
    // Check localStorage directly for debugging
    try {
      const storedAddons = localStorage.getItem('installedAddons');
      const parsedAddons = storedAddons ? JSON.parse(storedAddons) : [];
      console.log('StreamDialog: Direct localStorage check -', 
        storedAddons ? `found ${parsedAddons.length} addons` : 'no addons in localStorage');
    } catch (e) {
      console.error('StreamDialog: Error checking localStorage:', e);
    }
  }, [addonsLoading, installedAddons]);

  // Function to convert TMDB ID to IMDb ID
  const fetchImdbIdFromTmdb = useCallback(async (tmdbNumericId: string, type: 'movie' | 'series'): Promise<string | null> => {
    if (!tmdbApiKey) {
      console.warn('StreamDialog: TMDB API key is missing, cannot convert TMDB ID to IMDb ID.');
      setConversionError('TMDB API key missing. Cannot look up IMDb ID.');
      return null;
    }
    const tmdbType = type === 'series' ? 'tv' : 'movie';
    const url = `https://api.themoviedb.org/3/${tmdbType}/${tmdbNumericId}/external_ids?api_key=${tmdbApiKey}`;
    
    console.log(`StreamDialog: Fetching IMDb ID from TMDB: ${url}`);
    try {
      const response = await fetch(url);
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(`TMDB External IDs API error ${response.status}: ${errorData.status_message || response.statusText}`);
      }
      const data = await response.json();
      if (data.imdb_id) {
        console.log(`StreamDialog: Found IMDb ID: ${data.imdb_id} for TMDB ID: ${tmdbNumericId}`);
        return data.imdb_id;
      }
      console.warn(`StreamDialog: IMDb ID not found in TMDB external IDs for ${tmdbNumericId}`);
      setConversionError(`IMDb ID not found for this TMDB item.`);
      return null;
    } catch (err: any) {
      console.error("StreamDialog: Error fetching IMDb ID from TMDB:", err);
      setConversionError(`Failed to fetch IMDb ID: ${err.message}`);
      return null;
    }
  }, [tmdbApiKey]);

  // Fetch streams logic (adapted from stream page)
  const fetchStreams = useCallback(async () => {
    if (!open || !contentType || !contentId) return; // Don't fetch if not open or missing params

    setLoading(true);
    setStreams([]);
    setError(null);
    setConversionError(null); // Reset conversion error

    try {
      if (addonsLoading) {
        console.log('StreamDialog: Waiting for addons to load from context...');
        return;
      }

      const streamingAddons = installedAddons.filter(isStreamingAddon);

      if (!streamingAddons || streamingAddons.length === 0) {
        setError(
          'No streaming-capable addons installed. Please go to the Addons page and install an addon that provides streams (e.g., Torrentio, Orion, or a community addon that supports streams).'
        );
        // Offer to install sample (Cinemeta is a catalog addon, not a streaming one, so we need a real streaming example or remove this specific suggestion for now)
        // For now, let's just show the error and the button to the addons page.
        return;
      }

      // Build the video ID based on type, ID, and optional season/episode
      let videoId = `${contentId}`;
      if (contentType === 'series' && season && episode) {
        videoId = `${contentId}:${season}:${episode}`;
      }

      const allStreams: Stream[] = [];
      const fetchPromises: Promise<void>[] = [];
      let anAddonWasAttempted = false;

      // For each STREAMING addon, try to fetch streams
      for (const addon of streamingAddons) { // Use filtered list
        anAddonWasAttempted = true;
        let idForAddon = contentId;
        let videoIdForUrl = contentId; // This will include season/episode for series

        // Check if contentId is TMDB ID and needs conversion
        if (contentId.startsWith('tmdb:')) {
          const tmdbNumericIdOnly = contentId.substring(5);
          const imdbId = await fetchImdbIdFromTmdb(tmdbNumericIdOnly, contentType as 'movie' | 'series');
          if (imdbId) {
            idForAddon = imdbId; // Use IMDb ID for this addon
            videoIdForUrl = imdbId; // Update videoIdForUrl as well
          } else {
            // If conversion fails, log it and skip this addon for this TMDB item
            console.warn(`StreamDialog: Skipping addon ${addon.name} for TMDB item ${contentId} due to failed IMDb ID conversion.`);
            // Optionally, accumulate these errors to show a more specific message
            if (!conversionError) setConversionError(prev => prev ? `${prev}, ${addon.name}` : `Could not get IMDb ID for some sources (e.g., ${addon.name})`);
            continue; // Skip to the next addon
          }
        }
        
        // Build the final video ID for the URL (including season/episode if applicable)
        if (contentType === 'series' && season && episode) {
          videoIdForUrl = `${idForAddon}:${season}:${episode}`;
        } else {
          videoIdForUrl = idForAddon; // Ensure it uses the potentially converted ID
        }

        try {
          const manifestUrlParts = addon.manifestUrl.split('/');
          manifestUrlParts.pop();
          const baseUrl = manifestUrlParts.join('/');

          const fetchPromise = (async () => {
            try {
              const streamUrl = `${baseUrl}/stream/${contentType}/${videoIdForUrl}.json`;
              console.log(`StreamDialog: Fetching streams from ${addon.name}: ${streamUrl} (using ID: ${videoIdForUrl})`);

              const response = await fetch(streamUrl);
              if (!response.ok) {
                console.warn(`No streams available from ${addon.name} for ID ${videoIdForUrl}`);
                return;
              }
              const data = await response.json() as StreamResponse;
              console.log(`StreamDialog: Raw response from ${addon.name} for ID ${videoIdForUrl}:`, data); // Log the entire response

              if (data && Array.isArray(data.streams) && data.streams.length > 0) {
                // Process and add streams
                const processedStreams = data.streams.map(stream => {
                  console.log(`StreamDialog: Original stream object from ${addon.name}:`, JSON.parse(JSON.stringify(stream))); // Log original stream before enhancement

                  let enhancedStream: Stream = {
                    ...stream, // Start with the original stream object
                    addon: addon.id,
                    addonName: addon.name,
                    // Initialize potentially missing fields to avoid issues later
                    format: stream.format,
                    codec: stream.codec,
                    audio: stream.audio,
                    hdr: !!stream.hdr, // Ensure boolean
                    dv: !!stream.dv,   // Ensure boolean
                    language: stream.language,
                    release_group: stream.release_group,
                    size: stream.size, // Will be overridden if behaviorHints.videoSize is present
                    resolution: stream.resolution,
                    source: stream.source,
                    is10bit: !!stream.is10bit, // Initialize from stream object or ensure boolean
                    cachedInfo: stream.cachedInfo // Initialize from stream object
                  };

                  // --- Start of new parsing logic ---

                  // 1. Prioritize behaviorHints.videoSize for filesize
                  if (stream.behaviorHints && stream.behaviorHints.videoSize && typeof stream.behaviorHints.videoSize === 'number') {
                    const sizeInBytes = stream.behaviorHints.videoSize;
                    if (sizeInBytes >= 1073741824) { // GB
                      enhancedStream.size = `${(sizeInBytes / 1073741824).toFixed(2)} GB`;
                    } else if (sizeInBytes >= 1048576) { // MB
                      enhancedStream.size = `${(sizeInBytes / 1048576).toFixed(2)} MB`;
                    } else if (sizeInBytes > 0) {
                      enhancedStream.size = `${sizeInBytes} B`;
                    }
                  }

                  // Combine filename (highest priority), description, title, and name for comprehensive parsing
                  const filenameText = (stream.behaviorHints && stream.behaviorHints.filename) ? stream.behaviorHints.filename : '';
                  const descriptionText = stream.description || '';
                  const titleText = stream.title || '';
                  const nameText = stream.name || '';
                  
                  // Give priority to filename, then description, then title, then name
                  const sourceToParse = `${filenameText} ${descriptionText} ${titleText} ${nameText}`.toLowerCase();

                  // Regex patterns (keeping them as they are for now, might need refinement)
                  const formatPatterns = [
                    { regex: /\b(bluray|blu-ray|bdrip|remux)\b/i, format: 'BluRay' }, // Added remux
                    { regex: /\bweb-?dl\b/i, format: 'WEB-DL' },
                    { regex: /\bhdtv\b/i, format: 'HDTV' },
                    { regex: /\bdvdrip\b/i, format: 'DVDRip' },
                    { regex: /\bwebrip\b/i, format: 'WEBRip' },
                    { regex: /\bcam\b/i, format: 'CAM' },
                  ];

                  const codecPatterns = [
                    { regex: /\b(hevc|h\.?265|x\.?265)\b/i, codec: 'HEVC' },
                    { regex: /\b(avc|h\.?264|x\.?264)\b/i, codec: 'AVC' }, // Grouped H264/AVC
                    { regex: /\bvp9\b/i, codec: 'VP9' },
                    { regex: /\bav1\b/i, codec: 'AV1' },
                  ];

                  const audioPatterns = [
                    { regex: /\batmos\b/i, audio: 'Atmos' },
                    { regex: /\bdts-?hd(?:-?ma)?\b/i, audio: 'DTS-HD' }, // More specific DTS-HD
                    { regex: /\bdts\b/i, audio: 'DTS' }, // General DTS
                    { regex: /\bdolby\s*digital\s*plus\b|\bdd\+\b|\beac3\b/i, audio: 'DD+' },
                    { regex: /\bdolby\s*digital\b|\bdd\b|\bac3\b/i, audio: 'DD' },
                    { regex: /\b(?:5|7)\.1\b/i, audio: 'Surround' }, // General surround
                    { regex: /\btrue\s*hd\b/i, audio: 'TrueHD' },
                    { regex: /\baac\b/i, audio: 'AAC' },
                  ];

                  const hdrPatterns = [
                    { regex: /\bhdr10\+\b/i, hdr: true, dv: false }, // HDR10+
                    { regex: /\bhdr10\b/i, hdr: true, dv: false },  // HDR10
                    { regex: /\bhdr\b/i, hdr: true, dv: false },     // Generic HDR
                    { regex: /\bdv\b|\bdolby\s*vision\b/i, hdr: true, dv: true }, // Dolby Vision implies HDR
                  ];
                  
                  const resolutionPatterns = [
                    { regex: /\b(2160p|4k|ultra\s*hd)\b/i, resolution: '2160p' },
                    { regex: /\b(1080p|full\s*hd)\b/i, resolution: '1080p' },
                    { regex: /\b(720p|hd)\b/i, resolution: '720p' },
                    { regex: /\b480p\b/i, resolution: '480p' },
                  ];
                  
                  const languagePatterns = [
                      { regex: /\b(eng|english)\b/i, language: 'English' },
                      { regex: /\b(esp|spanish|espanol|latino)\b/i, language: 'Spanish' },
                      { regex: /\b(fre|french|français)\b/i, language: 'French' },
                      { regex: /\b(ger|german|deutsch)\b/i, language: 'German' },
                      { regex: /\b(ita|italian)\b/i, language: 'Italian' },
                      { regex: /\b(multi|dual\s*audio)\b/i, language: 'Multi Audio' },
                  ];

                  // Release group detection (often in square brackets or parentheses, or after a dash at the end)
                  const releaseGroupRegex = /(?:\b|-)([a-z0-9]+(?:-[a-z0-9]+)*)(?=\s*\.\w{2,4}$)|(?:\[|\()([a-z0-9\s-]+)(?:\]|\))/i;

                  // Apply parsing if not already present or to refine existing data
                  if (!enhancedStream.format) {
                    for (const p of formatPatterns) if (p.regex.test(sourceToParse)) { enhancedStream.format = p.format; break; }
                  }
                  if (!enhancedStream.codec) {
                    for (const p of codecPatterns) if (p.regex.test(sourceToParse)) { enhancedStream.codec = p.codec; break; }
                  }
                  if (!enhancedStream.audio) {
                    for (const p of audioPatterns) if (p.regex.test(sourceToParse)) { enhancedStream.audio = p.audio; break; }
                  }
                  
                  // HDR/DV - allow multiple matches if DV also sets HDR
                  for (const p of hdrPatterns) {
                      if (p.regex.test(sourceToParse)) {
                          if (p.hdr) enhancedStream.hdr = true;
                          if (p.dv) enhancedStream.dv = true;
                          // Don't break, allow DV to also set HDR if a generic HDR was found first
                      }
                  }

                  if (!enhancedStream.resolution) {
                    for (const p of resolutionPatterns) if (p.regex.test(sourceToParse)) { enhancedStream.resolution = p.resolution; break; }
                  }
                  if (!enhancedStream.language) {
                    for (const p of languagePatterns) if (p.regex.test(sourceToParse)) { enhancedStream.language = p.language; break; }
                  }
                  if (!enhancedStream.release_group) {
                    const rgMatch = sourceToParse.match(releaseGroupRegex);
                    if (rgMatch) {
                      enhancedStream.release_group = (rgMatch[1] || rgMatch[2] || '').trim();
                    }
                  }
                  
                  // Special handling for 10bit from description/filename 
                  if (!enhancedStream.is10bit && (sourceToParse.includes('10bit') || sourceToParse.includes('10-bit'))) {
                    enhancedStream.is10bit = true;
                  }

                  // Extract caching information specifically from the original description if not already set
                  if (!enhancedStream.cachedInfo && stream.description) {
                    const cachedOnRegex = /cached on ([\w\s,&]+)/i;
                    // Use stream.description directly here, not sourceToParse, to avoid lowercasing issues if provider names are case-sensitive
                    const cachedMatch = stream.description.match(cachedOnRegex);
                    if (cachedMatch && cachedMatch[1]) {
                      enhancedStream.cachedInfo = `Cached on ${cachedMatch[1].trim()}`;
                    }
                  }
                  
                  // Identify source (RD, PM, AD) - this can be refined
                  if (!enhancedStream.source) {
                      if (addon.name.toLowerCase().includes('rd') || nameText.toLowerCase().includes('[rd') || descriptionText.toLowerCase().includes('[rd')) enhancedStream.source = 'RD';
                      else if (addon.name.toLowerCase().includes('ad') || nameText.toLowerCase().includes('[ad') || descriptionText.toLowerCase().includes('[ad')) enhancedStream.source = 'AD';
                      else if (addon.name.toLowerCase().includes('pm') || nameText.toLowerCase().includes('[pm') || descriptionText.toLowerCase().includes('[pm')) enhancedStream.source = 'PM';
                  }

                  // --- End of new parsing logic ---
                  
                  // Cleanup: if release_group is the same as addonName or a generic term, clear it
                  if (enhancedStream.release_group && 
                      (enhancedStream.release_group.toLowerCase() === enhancedStream.addonName.toLowerCase() || 
                       enhancedStream.release_group.match(/^(english|spanish|multi)$/i))) {
                    enhancedStream.release_group = undefined;
                  }

                  console.log('StreamDialog: Enhanced stream metadata:', enhancedStream);
                  return enhancedStream;
                });

                allStreams.push(...processedStreams);
                console.log(`Added ${processedStreams.length} streams from ${addon.name}`);
              }
            } catch (addonError) {
              console.error(`Error fetching streams from ${addon.name}:`, addonError);
            }
          })();

          fetchPromises.push(fetchPromise);
        } catch (addonInitError) {
          console.error(`Error initializing fetch for ${addon.name}:`, addonInitError);
        }
      }

      // Wait for all fetchPromises to complete
      await Promise.all(fetchPromises);

      if (allStreams.length === 0) {
        if (conversionError && !error) {
            setError(conversionError); // Prioritize conversion error if no streams found
        } else if (!error) {
            setError(anAddonWasAttempted ? 'No streaming sources found from available addons.' : 'No addons available to fetch streams.');
        }
      } else {
        // Sort streams by quality (if available)
        const sortedStreams = allStreams.sort((a, b) => {
          // Try to sort by resolution/quality
          const getQualityValue = (stream: Stream) => {
            if (stream.resolution) {
              const match = stream.resolution.match(/\d+/);
              return match ? parseInt(match[0], 10) : 0;
            }
            if (stream.quality) {
              if (stream.quality.includes('1080')) return 1080;
              if (stream.quality.includes('720')) return 720;
              if (stream.quality.includes('480')) return 480;
              if (stream.quality.includes('HD')) return 720;
              if (stream.quality.includes('SD')) return 480;
            }
            return 0;
          };

          const qualityA = getQualityValue(a);
          const qualityB = getQualityValue(b);

          return qualityB - qualityA; // Higher quality first
        });

        setStreams(sortedStreams);

        // Set initial selected addon if there are streams
        if (sortedStreams.length > 0) {
           // Use initialAddonId if provided, otherwise default to the first addon found
           const initialSelected = initialAddonId && sortedStreams.some(s => s.addon === initialAddonId)
             ? initialAddonId
             : sortedStreams[0].addon;
          setSelectedAddon(initialSelected);
        }
      }
    } catch (err: any) {
      console.error('Error fetching streams:', err);
      setError(err.message || 'Failed to load streaming sources');
    } finally {
      setLoading(false);
    }
  }, [open, contentType, contentId, season, episode, initialAddonId, fetchImdbIdFromTmdb, installedAddons, addonsLoading, isStreamingAddon]);

  // Trigger fetch when dialog opens or parameters change
  useEffect(() => {
    if (open) {
      fetchStreams();
    } else {
      // Reset state when dialog closes
      setStreams([]);
      setLoading(false);
      setError(null);
      setSelectedAddon(null);
      setSelectedStream(null);
    }
  }, [open, fetchStreams, addonsLoading]);

  // Handle stream selection
  const handleStreamSelect = (stream: Stream) => {
    if (stream.externalUrl) {
      window.open(stream.externalUrl, '_blank');
    } else {
      setSelectedStream(stream);
    }
  };

  // Handle player close
  const handlePlayerClose = () => {
    setSelectedStream(null);
  };

  // Handle addon filter change
  const handleAddonChange = (event: any) => {
    setSelectedAddon(event.target.value as string);
  };

  // Get quality icon based on stream
  const getQualityIcon = (stream: Stream) => {
    // Only return PublicIcon for external streams, otherwise null
    if (stream.external) {
      return <PublicIcon fontSize="small" />;
    }
    return null; 
  };

  // Filter streams by selected addon
  const filteredStreams = selectedAddon
    ? streams.filter(stream => stream.addon === selectedAddon)
    : streams;

  // Get unique addons that have streams
  const availableAddons = [...new Set(streams.map(stream => stream.addon))];

  // Conditional rendering: Player view or Stream list view
  if (selectedStream) {
    return (
      <Dialog 
        fullScreen 
        open={!!selectedStream} // Controlled by selectedStream presence
        onClose={handlePlayerClose} 
        TransitionComponent={TransitionComponent}
        keepMounted={keepMounted} // Keep player mounted if specified by parent
        PaperProps={{ sx: { backgroundColor: 'black' } }}
      >
        <VideoPlayerWrapper
          url={selectedStream.url} 
          title={selectedStream.title || selectedStream.name || contentName}
          quality={selectedStream.quality || selectedStream.resolution || ''}
          addonName={selectedStream.addonName}
          onClose={handlePlayerClose} 
          autoPlay={true}
          // useStremio prop defaults to true in VideoPlayerWrapper
        />
      </Dialog>
    );
  }

  // Default view: Stream selection list
  return (
    <Dialog 
      open={open} 
      onClose={onClose} // Main dialog close
      TransitionComponent={TransitionComponent}
      fullWidth
      maxWidth="md"
      keepMounted={keepMounted}
      PaperProps={{
        sx: {
          bgcolor: '#141414',
          color: 'white',
          height: '90vh', // Set a max height for the dialog
          maxHeight: '700px',
          width: '95vw',
          maxWidth: '800px',
          borderRadius: '8px',
          display: 'flex', // Enable flex column layout
          flexDirection: 'column'
        }
      }}
    >
      <DialogTitle sx={{ m: 0, p: 2, bgcolor: '#181818', flexShrink: 0 /* Prevent title from shrinking */ }}>
            <Typography variant="h6" component="div" sx={{ fontWeight: 'bold' }}>
              {contentName}
            </Typography>
            {episodeInfo && (
              <Typography variant="body2" sx={{ color: 'grey.400' }}>
                {episodeInfo}
              </Typography>
            )}
            <IconButton
              aria-label="close"
              onClick={onClose}
              sx={{
                position: 'absolute',
                right: 8,
                top: 8,
                color: (theme) => theme.palette.grey[500],
              }}
            >
              <CloseIcon />
            </IconButton>
          </DialogTitle>

      <DialogContent dividers sx={{ bgcolor: '#141414', p: { xs: 1.5, sm: 2, md: 3 }, position: 'relative', flexGrow: 1 /* Allow content to grow */, overflowY: 'auto' /* Ensure content scrolls */ }}>
            {/* Loading indicator */}
            {loading && (
          <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100%', position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 1, backgroundColor: 'rgba(0,0,0,0.5)' }}>
                <CircularProgress color="inherit" />
              </Box>
            )}

            <Collapse in={!loading} timeout="auto" unmountOnExit> 
              {error || conversionError ? (
                <Alert
                  severity="warning"
                  sx={{
                    backgroundColor: '#333',
                    color: 'white',
                    '.MuiAlert-icon': { color: 'white' },
                    minHeight: '100px',
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'flex-start'
                  }}
                >
                  <Typography sx={{ mb: 1 }}>{error || conversionError}</Typography>
                  {error?.includes('No streaming-capable addons installed') && (
                    <Button 
                      color="primary" 
                      size="small" 
                      variant="outlined"
                      onClick={() => {
                    onClose(); // Close the dialog first
                    window.location.href = '/addons'; // Navigate
                      }}
                      sx={{ mt: 1 }}
                    >
                      Go to Addons Page
                    </Button>
                  )}
                </Alert>
              ) : (
                <>
                  {availableAddons.length > 1 && (
                <Box sx={{ mb: 2, maxWidth: { xs: '100%', sm: '300px' } }}>
                      <FormControl fullWidth variant="filled" size="small">
                        <InputLabel id="addon-select-label" sx={{ color: 'grey.300' }}>
                          Addon Source
                        </InputLabel>
                        <Select
                          labelId="addon-select-label"
                          value={selectedAddon || ''}
                          onChange={handleAddonChange}
                          label="Addon Source"
                          sx={{
                            color: 'white',
                            backgroundColor: 'rgba(255,255,255,0.08)',
                            '&:hover': { backgroundColor: 'rgba(255,255,255,0.12)' },
                            '.MuiFilledInput-input': { py: 1.5 },
                            '.MuiSvgIcon-root': { color: 'white' }
                          }}
                          disableUnderline
                        >
                          {availableAddons.map(addonId => {
                        const addonInfo = installedAddons.find(ad => ad.id === addonId);
                        const addonName = addonInfo?.name || streams.find(s => s.addon === addonId)?.addonName || addonId;
                            return (
                              <MenuItem key={addonId} value={addonId} sx={{ bgcolor: '#333', '&:hover': { bgcolor: '#444' } }}>
                                {addonName}
                              </MenuItem>
                            );
                          })}
                        </Select>
                      </FormControl>
                    </Box>
                  )}

              <Typography variant="body2" component="h3" sx={{ mb: 1, fontWeight: 'medium', color: 'grey.300' }}>
                    Available Streams {filteredStreams.length > 0 && `(${filteredStreams.length})`}
                  </Typography>

                  {filteredStreams.length > 0 ? (
                <List sx={{ p: 0, bgcolor: 'rgba(0,0,0,0.1)', borderRadius: '4px', overflow: 'hidden' }}>
                      {filteredStreams.map((stream, index) => (
                    <React.Fragment key={`${stream.addon}-${stream.url}-${index}`}> {/* Ensure key is unique enough */}
                      {index > 0 && <Divider sx={{ borderColor: 'rgba(255,255,255,0.05)' }} />}
                          <ListItem
                            component="div"
                            onClick={() => handleStreamSelect(stream)}
                            sx={{
                              cursor: 'pointer',
                          '&:hover': { backgroundColor: 'rgba(255,255,255,0.05)' },
                          py: 1.2, 
                          px: 1.5 
                            }}
                          >
                            {stream.external && (
                          <ListItemIcon sx={{ color: 'grey.400', minWidth: '36px' }}>
                                <PublicIcon fontSize="small" />
                              </ListItemIcon>
                            )}
                            <ListItemText
                              primary={
                            <Typography variant="body1" sx={{ color: 'grey.100' }}>
                              {stream.title || stream.name || `Stream from ${stream.addonName}`}
                                </Typography>
                              }
                              secondary={
                            <Box component="span" sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.75, color: 'grey.400', fontSize: '0.75rem', mt: 0.5 }}>
                                  {stream.quality && (
                                <Box component="span" sx={{ bgcolor: 'rgba(255,255,255,0.07)', px: 0.8, py: 0.2, borderRadius: '3px' }}>
                                      {stream.quality}
                                    </Box>
                                  )}
                                  {stream.resolution && (
                                <Box component="span" sx={{ bgcolor: 'rgba(255,255,255,0.07)', px: 0.8, py: 0.2, borderRadius: '3px' }}>
                                      {stream.resolution}
                                    </Box>
                                  )}
                                  {stream.size && (
                                <Box component="span" sx={{ bgcolor: 'rgba(255,255,255,0.07)', px: 0.8, py: 0.2, borderRadius: '3px' }}>
                                      {stream.size}
                                    </Box>
                                  )}
                              <Box component="span" sx={{ opacity: 0.8 }}>
                                    via {stream.addonName}
                                  </Box>
                                  {stream.cachedInfo && (
                                <Typography variant="caption" sx={{ color: '#4caf50', fontSize: '0.7rem', display: 'inline-block', ml: 0.5 }}>
                                  ({stream.cachedInfo})
                                    </Typography>
                                  )}
                                  {stream.description && (
                                    <Typography 
                                      variant="caption" 
                                  component="pre" 
                                      sx={{ 
                                        color: 'grey.500', 
                                    fontSize: '0.6rem', 
                                    mt: 0.5, 
                                        display: 'block', 
                                    whiteSpace: 'pre-wrap', 
                                    wordBreak: 'break-word',
                                    width: '100%' // Ensure it takes full width if needed
                                      }}
                                    >
                                      {stream.description}
                                    </Typography>
                                  )}
                                </Box>
                              }
                              secondaryTypographyProps={{ component: 'div' }}
                            />
                        <ListItemIcon sx={{ color: '#e50914', minWidth: 'auto', pl: 1 }}>
                              <PlayArrowIcon fontSize="small" />
                            </ListItemIcon>
                          </ListItem>
                        </React.Fragment>
                      ))}
                    </List>
                  ) : (
                <Typography variant="body2" sx={{ color: 'grey.400', textAlign: 'center', py: 3 }}>
                  {loading ? 'Loading streams...' : (streams.length > 0 ? 'No streams available from this addon' : 'No streams found for this content.')}
                    </Typography>
                  )}
                  
              <Typography variant="caption" sx={{ display: 'block', color: 'grey.500', fontStyle: 'italic', textAlign: 'center', mt: 2, pb: 1 }}>
                    {streams.some(s => s.external) 
                  ? 'External links open in a new tab. Other streams play in the built-in player.' 
                  : 'Click a stream to play in the built-in player.'}
                  </Typography>
                </>
              )}
            </Collapse>
          </DialogContent>

      <DialogActions sx={{ p: 1.5, bgcolor: '#181818', borderTop: '1px solid rgba(255,255,255,0.1)', flexShrink: 0 /* Prevent actions from shrinking */ }}>
            <Button onClick={onClose} sx={{ color: 'grey.400' }}>
              Close
            </Button>
          </DialogActions>
    </Dialog>
  );
}