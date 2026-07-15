'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { useParams, useSearchParams, useRouter } from 'next/navigation';
import Image from 'next/image';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import PlayArrow from '@mui/icons-material/PlayArrow';
import AddIcon from '@mui/icons-material/Add';
import VolumeOffIcon from '@mui/icons-material/VolumeOff';
import Link from 'next/link';
import Alert from '@mui/material/Alert';
import Select from '@mui/material/Select';
import MenuItem from '@mui/material/MenuItem';
import FormControl from '@mui/material/FormControl';
import Divider from '@mui/material/Divider';
import StreamDialog from '../../../../components/StreamDialog';
import VideocamIcon from '@mui/icons-material/Videocam';
import EpisodeItem from './EpisodeItem';
import Fade from '@mui/material/Fade';
import Grow from '@mui/material/Grow';
import { TransitionProps } from '@mui/material/transitions';
import Zoom from '@mui/material/Zoom';
import Slide from '@mui/material/Slide';
import { useAddonContext } from '@/context/AddonContext';
import { useTmdbContext } from '@/context/TmdbContext';
import { Chip, Paper } from '@mui/material';
import List from '@mui/material/List';
import ListItem from '@mui/material/ListItem';
import ListItemText from '@mui/material/ListItemText';

interface MetaDetails {
  id: string;
  type: string;
  name: string;
  poster?: string;
  background?: string;
  logo?: string;
  description?: string;
  releaseInfo?: string;
  runtime?: string;
  year?: number;
  genres?: string[];
  director?: string[];
  cast?: string[];
  imdbRating?: string;
  country?: string[];
  language?: string[];
  certification?: string;
  trailer?: string;
  videos?: { id: string; title: string; season?: number; episode?: number }[];
  seasons?: Season[];
}

// Basic metadata we can extract from catalog items
interface BasicMeta {
  id: string;
  type: string;
  name: string;
  poster?: string;
}

// Add episode interfaces
interface Episode {
  id: string;
  title: string;
  overview?: string;
  thumbnail?: string;
  season: number;
  episode: number;
  released?: string;
  runtime?: string;
}

interface Season {
  season: number;
  title?: string;
  episodes: Episode[];
}

// State for the stream dialog target
interface StreamTarget {
  season?: number | null;
  episode?: number | null;
}

// Define the Transition component using Grow
const Transition = React.forwardRef(function Transition(
  props: TransitionProps & {
    children: React.ReactElement<any, any>;
  },
  ref: React.Ref<unknown>,
) {
  return <Grow ref={ref} {...props} timeout={500} />;
});

// After animation duration constant
const ANIMATION_DURATION = 600; // in ms
const HERO_ANIMATION_DURATION = 1000; // Hero animation slightly longer for dramatic effect

// Helper to check if an object looks like a Meta object (basic check)
function hasMinimalProperties(obj: any): obj is Meta {
  return obj && typeof obj.id === 'string' && typeof obj.name === 'string' && typeof obj.type === 'string';
}

// Helper function to enhance image URLs
const getEnhancedImageUrl = (url: string | undefined): string => {
  if (!url) return ''; // Empty string fallback instead of undefined

  // Check if it's a Metahub URL before attempting replacements
  if (url.startsWith('https://images.metahub.space/') || url.startsWith('http://images.metahub.space/')) {
    // If the path segment looks like an IMDb ID (e.g., /tt1234567/), don't modify it,
    // as the enhancement logic is for standard paths, not direct ID links.
    // This is a basic check; more robust IMDb ID detection could be added if needed.
    const pathPart = url.substring(url.indexOf('.space/') + 7);
    if (/^tt\d{7,}/.test(pathPart)) {
      console.log(`getEnhancedImageUrl: Detected IMDb ID in Metahub URL, returning original: ${url}`);
      return url; 
    }
    
    // Convert metahub background URLs from medium to large
    if (url.includes('/background/medium/')) {
      return url.replace('/background/medium/', '/background/large/');
    }
    
    // Convert metahub poster URLs from medium to large if needed
    if (url.includes('/poster/medium/')) {
      return url.replace('/poster/medium/', '/poster/large/');
    }
    
    // Convert metahub logo URLs from medium to large if needed
    if (url.includes('/logo/medium/')) {
      return url.replace('/logo/medium/', '/logo/large/');
    }
  }
  
  // For other URLs (including direct TMDB image URLs or non-Metahub URLs),
  // or Metahub URLs that weren't modified above, return them as is.
  return url;
};

// --- Helper function to fetch data from TMDB ---
const fetchTmdbData = async (path: string, apiKey: string, params?: Record<string, string>) => {
  let queryString = `api_key=${apiKey}`;
  if (params) {
    queryString += `&${new URLSearchParams(params).toString()}`;
  }
  const url = `https://api.themoviedb.org/3${path}?${queryString}`;
  console.log(`Fetching TMDB data from: ${url}`);
  const response = await fetch(url);
  if (!response.ok) {
    const errorData = await response.json().catch(() => ({})); // Try to parse error, default to empty obj
    throw new Error(
      `TMDB API error ${response.status}: ${response.statusText}. ` +
      `${errorData?.status_message || 'No additional error message from TMDB.'}`
    );
  }
  return response.json();
};

// --- Helper function to transform TMDB API response to our Meta interface ---
const transformTmdbDetailsToMeta = (tmdbData: any, type: string, originalId: string): Meta => {
  const getYear = (dateString?: string): number | undefined => {
    if (!dateString) return undefined;
    return parseInt(dateString.substring(0, 4), 10);
  };

  // Update to use original size for all images
  const getPosterUrl = (path?: string) => path ? `https://image.tmdb.org/t/p/original${path}` : undefined;
  const getBackdropUrl = (path?: string) => path ? `https://image.tmdb.org/t/p/original${path}` : undefined;
  
  let logoPath: string | undefined = undefined;
  console.log("transformTmdbDetailsToMeta: Raw tmdbData.images:", tmdbData.images); // Log raw images object
  if (tmdbData.images?.logos?.length > 0) {
    const englishLogo = tmdbData.images.logos.find((logo: any) => logo.iso_639_1 === 'en');
    logoPath = englishLogo?.file_path || tmdbData.images.logos[0]?.file_path;
    console.log("transformTmdbDetailsToMeta: Found logoPath:", logoPath); // Log selected logoPath
  } else {
    console.log("transformTmdbDetailsToMeta: No logos found in tmdbData.images.logos");
  }
  const getLogoUrl = (path?: string) => path ? `https://image.tmdb.org/t/p/original${path}` : undefined;
  const finalLogoUrl = getLogoUrl(logoPath);
  console.log("transformTmdbDetailsToMeta: Final constructed logo URL:", finalLogoUrl); // Log final URL

  let director: string | undefined = undefined;
  if (tmdbData.credits?.crew?.length > 0) {
    const directorEntry = tmdbData.credits.crew.find((person: any) => person.job === 'Director');
    if (directorEntry) director = directorEntry.name;
  }

  const cast = tmdbData.credits?.cast?.slice(0, 15).map((actor: any) => actor.name) || [];

  let trailerUrl: string | undefined = undefined;
  if (tmdbData.videos?.results?.length > 0) {
    const officialTrailer = tmdbData.videos.results.find(
        (video: any) => video.type === 'Trailer' && video.official && video.site === 'YouTube'
    );
    if (officialTrailer) {
        trailerUrl = `https://www.youtube.com/watch?v=${officialTrailer.key}`;
    } else {
        // Fallback to any trailer if no official one
        const anyTrailer = tmdbData.videos.results.find((video: any) => video.type === 'Trailer' && video.site === 'YouTube');
        if (anyTrailer) trailerUrl = `https://www.youtube.com/watch?v=${anyTrailer.key}`;
    }
  }
  
  let certification: string | undefined = undefined;
  if (type === 'movie' && tmdbData.release_dates?.results) {
    const usRelease = tmdbData.release_dates.results.find((r: any) => r.iso_3166_1 === 'US');
    if (usRelease?.release_dates?.length > 0) {
      certification = usRelease.release_dates.find((rd: any) => rd.certification !== "")?.certification;
    }
  } else if (type === 'series' && tmdbData.content_ratings?.results) {
    const usRating = tmdbData.content_ratings.results.find((r: any) => r.iso_3166_1 === 'US');
    certification = usRating?.rating;
  }

  const releaseDate = tmdbData.release_date || tmdbData.first_air_date;

  return {
    id: originalId, // Use the original id like 'tmdb:12345'
    type: type, // 'movie' or 'series'
    name: tmdbData.title || tmdbData.name || 'Untitled',
    poster: getPosterUrl(tmdbData.poster_path),
    background: getBackdropUrl(tmdbData.backdrop_path),
    logo: finalLogoUrl,
    description: tmdbData.overview || 'No description available.',
    releaseInfo: releaseDate ? releaseDate.substring(0, 4) : 'N/A', // Just year for now
    year: getYear(releaseDate),
    runtime: tmdbData.runtime 
      ? `${tmdbData.runtime} min` 
      : (tmdbData.episode_run_time?.[0] ? `${tmdbData.episode_run_time[0]} min/ep` : undefined),
    genres: tmdbData.genres?.map((g: any) => g.name) || [],
    director: director ? [director] : undefined, // Meta expects string[] or string
    cast: cast,
    imdbRating: tmdbData.vote_average ? tmdbData.vote_average.toFixed(1) : undefined,
    country: tmdbData.production_countries?.map((c: any) => c.name) || [],
    language: tmdbData.spoken_languages?.map((l: any) => l.english_name) || [],
    certification: certification,
    trailer: trailerUrl,
    // videos: tmdbData.videos?.results.map((v:any) => ({id: v.key, title: v.name, type: v.type, site: v.site})), // map if needed
    // seasons: handled separately for series
  };
};

// --- Helper function to transform TMDB Episode data to our Episode interface ---
const transformTmdbEpisodeToLocalFormat = (tmdbEpisode: any, seriesTmdbId: string): Episode => {
  return {
    id: `tmdb:${seriesTmdbId}-s${tmdbEpisode.season_number}-e${tmdbEpisode.episode_number}`, // Unique ID
    title: tmdbEpisode.name || `Episode ${tmdbEpisode.episode_number}`,
    overview: tmdbEpisode.overview || '',
    thumbnail: tmdbEpisode.still_path ? `https://image.tmdb.org/t/p/w300${tmdbEpisode.still_path}` : '', // w300 for stills
    season: tmdbEpisode.season_number,
    episode: tmdbEpisode.episode_number,
    released: tmdbEpisode.air_date || '',
    runtime: tmdbEpisode.runtime ? `${tmdbEpisode.runtime} min` : ''
  };
};

interface Meta {
    id: string;
    type: 'movie' | 'series' | string;
    name: string;
    poster?: string;
    background?: string;
    description?: string;
    director?: string | string[];
    cast?: string[];
    runtime?: string;
    releaseInfo?: string; // Year string
    year?: number; // Numeric year
    imdbRating?: string;
    genres?: string[];
    logo?: string;
    videos?: { id: string; title: string; season?: number; episode?: number }[];
    streams?: any[];
    seasons?: Season[];
    certification?: string;
    country?: string[];
    language?: string[];
    trailer?: string;
}

export default function DetailsPage() {
  const params = useParams();
  const searchParams = useSearchParams();
  const router = useRouter();
  const { type: routeType, id: rawId } = params;
  const sourceAddonId = searchParams.get('addonId');
  const { 
    installedAddons, 
    isLoading: isLoadingAddons, 
    error: addonContextError,
    getAddonById // Get the function from context
  } = useAddonContext(); // Use context
  const { tmdbApiKey, isTmdbEnabled } = useTmdbContext(); // Get TMDB context values
  
  // Decode the ID parameter
  const id = typeof rawId === 'string' ? decodeURIComponent(rawId) : Array.isArray(rawId) ? decodeURIComponent(rawId[0]) : '';

  // Type assertion/guard for route params
  const type = typeof routeType === 'string' ? routeType : '';

  const [details, setDetails] = useState<Meta | null>(null);
  const [loadingDetails, setLoadingDetails] = useState<boolean>(true);
  const [pageError, setPageError] = useState<string | null>(null);
  const [partialMetadata, setPartialMetadata] = useState<boolean>(false);
  const [selectedSeason, setSelectedSeason] = useState<number>(1);
  const [episodes, setEpisodes] = useState<Episode[]>([]);
  const [loadingEpisodes, setLoadingEpisodes] = useState<boolean>(false);
  const [episodesError, setEpisodesError] = useState<string | null>(null);
  const [availableSeasons, setAvailableSeasons] = useState<number[]>([]);
  
  // State for Stream Dialog
  const [isStreamDialogOpen, setIsStreamDialogOpen] = useState(false);
  const [streamTarget, setStreamTarget] = useState<StreamTarget | null>(null);
  
  // Animation states
  const [contentLoaded, setContentLoaded] = useState(false);
  
  const getCatalogUniqueId = (catalog: { type: string; id: string }) => `${catalog.type}/${catalog.id}`;

  // --- Restore fetchSeasons function --- 
  const fetchSeasons = useCallback(async (addonBaseUrl: string, seriesType: string, seriesId: string): Promise<number[]> => {
    try {
      const metaUrl = `${addonBaseUrl}/meta/${seriesType}/${seriesId}.json`;
      console.log(`DetailsPage (Seasons): Trying meta endpoint: ${metaUrl}`);
      const response = await fetch(metaUrl);
      if (response.ok) {
        const data = await response.json();
        if (data && data.meta && Array.isArray(data.meta.videos)) {
          const seasonNumbersSet = new Set<number>();
          data.meta.videos.forEach((video: any) => {
            if (video.season !== undefined && video.season !== null) {
              const seasonNum = Number(video.season);
              if (!isNaN(seasonNum)) seasonNumbersSet.add(seasonNum);
            }
          });
          const seasonNumbers = Array.from(seasonNumbersSet).sort((a, b) => a - b);
          if (seasonNumbers.length > 0) {
            console.log(`DetailsPage (Seasons): Found seasons in meta:`, seasonNumbers);
            setAvailableSeasons(seasonNumbers);
            return seasonNumbers;
          }
        }
      }
      // Fallback (you might have other legacy endpoints)
      console.log(`DetailsPage (Seasons): Meta endpoint didn't yield seasons, assuming season 1.`);
      setAvailableSeasons([1]);
      return [1]; 
    } catch (err) {
      console.error(`DetailsPage (Seasons): Error fetching seasons for ${seriesId}:`, err);
      setAvailableSeasons([1]); // Default fallback
      return [1];
    }
  }, []); // Empty dependency array, relies on arguments

  // --- Restore fetchEpisodes function ---
  const fetchEpisodes = useCallback(async (addonBaseUrl: string, seriesType: string, seriesId: string, season: number) => {
    setLoadingEpisodes(true);
    setEpisodesError(null);
    setEpisodes([]); // Clear previous episodes
    try {
      const metaSeasonUrl = `${addonBaseUrl}/meta/${seriesType}/${seriesId}/season=${season}.json`;
      console.log(`DetailsPage (Episodes): Fetching episodes from: ${metaSeasonUrl}`);
      const response = await fetch(metaSeasonUrl);
      if (!response.ok) throw new Error(`HTTP error ${response.status} fetching episodes from ${metaSeasonUrl}`);
      
      const data = await response.json();
      let fetchedEpData: Episode[] = [];

      if (data?.meta?.episodes) {
          fetchedEpData = data.meta.episodes.map((ep: any): Episode => ({
            id: ep.id || `${seriesId}-s${season}-e${ep.episode || 0}`,
            title: ep.title || ep.name || `Episode ${ep.episode || 0}`,
            overview: ep.overview || ep.description || '',
            thumbnail: ep.thumbnail || ep.poster || '',
            season: season,
            episode: ep.episode || ep.number || 0,
            released: ep.released || ep.air_date || '',
            runtime: ep.runtime || ep.duration || ''
          }));
      } else if (data?.meta?.videos) { // Check videos array as fallback
           fetchedEpData = data.meta.videos
            .filter((v: any) => v.season === season || (season === 1 && v.season === undefined)) // Filter by season
            .map((v: any): Episode => ({ 
              id: v.id || `${seriesId}-s${season}-e${v.episode || 0}`,
              title: v.title || v.name || `Episode ${v.episode || 0}`,
              overview: v.overview || v.description || '',
              thumbnail: v.thumbnail || v.poster || '',
              season: season,
              episode: v.episode || v.number || 0,
              released: v.released || '',
              runtime: v.runtime || ''
            }));
      }
      
      if (fetchedEpData.length > 0) {
          console.log(`DetailsPage (Episodes): Successfully fetched ${fetchedEpData.length} episodes for S${season}.`);
          setEpisodes(fetchedEpData);
      } else {
          console.warn(`DetailsPage (Episodes): No episodes found in response for S${season}.`);
          setEpisodesError('No episode information available for this season.');
      }

    } catch (err: any) {
      console.error(`DetailsPage (Episodes): Error fetching episodes for ${seriesId} S${season}:`, err);
      setEpisodesError(err.message || 'Failed to load episodes for this season');
    } finally {
      setLoadingEpisodes(false);
    }
  }, []); // Empty dependency array, relies on arguments

  // --- Main useEffect to fetch DETAILS --- 
  useEffect(() => {
    if (!id || !type) {
      setPageError('Missing item ID or type.');
      setLoadingDetails(false);
      return;
    }
    
    // Wait for addons context to finish loading (TMDB context loads quickly/independently)
    if (isLoadingAddons) {
        setLoadingDetails(true); 
        return;
    }

    // --- Check for TMDB ID and settings ---
    const isTmdbId = id.startsWith('tmdb:');
    const canFetchTmdb = isTmdbId && isTmdbEnabled && !!tmdbApiKey;

    // --- Function to fetch and transform TMDB data ---
    const fetchTmdbDetails = async () => {
        setLoadingDetails(true);
        setPageError(null);
        setPartialMetadata(false);
        setDetails(null);
        
        if (!tmdbApiKey) { // Double check just in case
            setPageError("TMDB API Key is missing.");
            setLoadingDetails(false);
            return;
        }
        
        if (typeof id !== 'string') {
            setPageError("Invalid item ID format.");
            setLoadingDetails(false);
            return;
        }

        const numericId = id.substring(5); // Use decoded id
        const tmdbType = type === 'series' ? 'tv' : 'movie';
        const path = `/${tmdbType}/${numericId}`;
        const queryParams = {
            append_to_response: `images,videos,credits,external_ids${tmdbType === 'tv' ? ',content_ratings' : ''}`,
            language: 'en-US'
        };

        try {
            console.log(`DetailsPage (TMDB): Fetching details for ${path}`);
            const tmdbData = await fetchTmdbData(path, tmdbApiKey, queryParams);
            console.log(`DetailsPage (TMDB): Received data:`, tmdbData);

            const transformedDetails = transformTmdbDetailsToMeta(tmdbData, type, id as string);
            // Temp placeholder until transform function is ready
            /* const transformedDetails: Meta = {
                 id: id, // Keep original tmdb: prefix id
                 type: type,
                 name: tmdbData.title || tmdbData.name || 'Untitled',
                 poster: tmdbData.poster_path ? `https://image.tmdb.org/t/p/w500${tmdbData.poster_path}` : undefined,
                 background: tmdbData.backdrop_path ? `https://image.tmdb.org/t/p/w1280${tmdbData.backdrop_path}` : undefined,
                 description: tmdbData.overview || 'No description available.',
                 releaseInfo: tmdbData.release_date || tmdbData.first_air_date || '',
                 imdbRating: tmdbData.vote_average?.toFixed(1) || undefined,
                 genres: tmdbData.genres?.map((g: any) => g.name) || [],
                 runtime: tmdbData.runtime ? `${tmdbData.runtime} min` : (tmdbData.episode_run_time?.[0] ? `${tmdbData.episode_run_time[0]} min/ep` : undefined),
                 // Add more fields later in the proper transform function
             }; */

            setDetails(transformedDetails);

            // --- Fetch images separately with the dedicated endpoint ---
            // This ensures we get both English and language-neutral logos, and high-quality backdrops
            const fetchTmdbImages = async () => {
              try {
                const imagePath = `/${tmdbType}/${numericId}/images`;
                const imageParams = {
                  api_key: tmdbApiKey,
                  include_image_language: 'en,null'  // Get English and language-neutral images
                };
                
                // Construct URL manually since we're using a different parameter format
                const queryString = new URLSearchParams(imageParams).toString();
                const imageUrl = `https://api.themoviedb.org/3${imagePath}?${queryString}`;
                
                console.log(`DetailsPage (TMDB): Fetching images from: ${imageUrl}`);
                const response = await fetch(imageUrl);
                if (!response.ok) {
                  throw new Error(`Image fetch failed: ${response.status}`);
                }
                
                const imageData = await response.json();
                console.log(`DetailsPage (TMDB): Got image data:`, imageData);
                
                // Update details object with a functional update to ensure we have the latest state
                setDetails(prevDetails => {
                  if (!prevDetails) return null;
                  
                  const updatedDetails = {...prevDetails};
                  
                  // --- LOGO HANDLING ---
                  // Check if there are logos
                  if (imageData.logos && imageData.logos.length > 0) {
                    // Find the best logo (prefer English, then null language, then first available)
                    const englishLogo = imageData.logos.find((logo: any) => logo.iso_639_1 === 'en');
                    const neutralLogo = imageData.logos.find((logo: any) => logo.iso_639_1 === null);
                    const bestLogo = englishLogo || neutralLogo || imageData.logos[0];
                    
                    if (bestLogo) {
                      // Construct logo URL with original size for best quality
                      const logoImageUrl = `https://image.tmdb.org/t/p/original${bestLogo.file_path}`;
                      console.log(`DetailsPage (TMDB): Using logo URL: ${logoImageUrl}`);
                      updatedDetails.logo = logoImageUrl;
                    }
                  } else {
                    console.log(`DetailsPage (TMDB): No logos found for ${tmdbType}/${numericId}`);
                  }
                  
                  // --- BACKDROP HANDLING ---
                  // Check if there are backdrops and select the best one
                  if (imageData.backdrops && imageData.backdrops.length > 0) {
                    // Sort by vote average (if available) or vote count, then take the first (best) one
                    const sortedBackdrops = [...imageData.backdrops];
                    sortedBackdrops.sort((a, b) => {
                      // First try to sort by vote_average
                      if (a.vote_average !== undefined && b.vote_average !== undefined) {
                        return b.vote_average - a.vote_average;
                      }
                      // Then try to sort by vote_count
                      if (a.vote_count !== undefined && b.vote_count !== undefined) {
                        return b.vote_count - a.vote_count;
                      }
                      // Default to the order they came in
                      return 0;
                    });
                    
                    const bestBackdrop = sortedBackdrops[0];
                    const backdropUrl = `https://image.tmdb.org/t/p/original${bestBackdrop.file_path}`;
                    console.log(`DetailsPage (TMDB): Using high-quality backdrop: ${backdropUrl}`);
                    updatedDetails.background = backdropUrl;
                  }
                  
                  return updatedDetails;
                });
                
              } catch (error) {
                console.error(`DetailsPage (TMDB): Error fetching images:`, error);
                // Don't set an error state or affect the UI if image fetch fails
              }
            };
            
            // Call the images fetch function
            fetchTmdbImages();

            // --- Handle TMDB Series Seasons ---
            if (tmdbType === 'tv' && tmdbData.seasons) {
                const seasonNumbers = tmdbData.seasons
                    .filter((s: any) => s.season_number !== 0) // Often season 0 is specials
                    .map((s: any) => s.season_number)
                    .sort((a: number, b: number) => a - b);
                console.log(`DetailsPage (TMDB): Found seasons:`, seasonNumbers);
                setAvailableSeasons(seasonNumbers);
                // If seasons exist, set default selected season
                if (seasonNumbers.length > 0) {
                    setSelectedSeason(seasonNumbers[0]); 
                } else {
                    setSelectedSeason(1); // Fallback if filter removed all seasons
                    setAvailableSeasons([1]); // Set fallback
                }
            } else {
                 setAvailableSeasons([]);
                 setEpisodes([]);
            }

        } catch (error: any) {
            console.error(`DetailsPage (TMDB): Error fetching details:`, error);
            setPageError(`Failed to load details from TMDB: ${error.message}`);
            // Maybe fallback to Stremio here? For now, just show error.
        } finally {
            setLoadingDetails(false);
        }
    };
    
    // --- Function to fetch Stremio addon details (existing logic) ---
    const fetchStremioDetails = async () => {
      // --- Existing Stremio fetching logic starts here ---
      setLoadingDetails(true);
      setPageError(null); // Clear previous page-specific errors
      setPartialMetadata(false);
      setDetails(null);

      let fetchedDetails: Meta | null = null;
      let detailFetchError: string | null = null;
      let triedBasicMeta = false;

      // --- Prioritize Addons ---
      const prioritizedAddons = [...installedAddons];
      if (sourceAddonId) {
          const sourceIndex = prioritizedAddons.findIndex(a => a.id === sourceAddonId);
          if (sourceIndex > 0) {
              const [sourceAddon] = prioritizedAddons.splice(sourceIndex, 1);
              prioritizedAddons.unshift(sourceAddon);
              console.log(`DetailsPage: Prioritizing source addon: ${sourceAddon.name}`);
          }
      }
      // --- End Prioritize Addons ---

      if (prioritizedAddons.length === 0) {
          setPageError("No suitable addons found to fetch details.");
          setLoadingDetails(false);
          return;
      }

      // 1. Fetch Full Metadata
      console.log(`DetailsPage: Fetching details for ${type} ${id} from ${prioritizedAddons.length} addons.`);
      let partialMeta: Meta | null = null;
      for (const addon of prioritizedAddons) {
        // Skip if addon has no meta resource defined or doesn't support the type
        const providesMeta = addon.resources?.some(resource => 
            (typeof resource === 'string' && resource === 'meta') ||
            (typeof resource === 'object' && resource.name === 'meta' && (!resource.types || resource.types.includes(type)))
        );
        if (!providesMeta) {
            console.log(`DetailsPage: Skipping meta fetch for ${addon.name} (doesn't provide meta for type ${type})`);
            continue;
        }

        // --- Add check for TMDB ID before querying Stremio addon ---
        console.log(`DetailsPage: Checking ID value before skip: '${id}' (type: ${typeof id})`);
        if (id.startsWith('tmdb:')) {
            console.warn(`DetailsPage: Skipping meta fetch for ${addon.name} (${type}/${id}) because Stremio addons don't support 'tmdb:' prefixed IDs directly.`);
            continue; // Skip this addon for this ID
        }
        // --- End check ---

        try {
          const manifestUrlParts = addon.manifestUrl.split('/');
          manifestUrlParts.pop();
          const baseUrl = manifestUrlParts.join('/');
          const metaUrl = `${baseUrl}/meta/${type}/${id}.json`;
          console.log(`DetailsPage: Trying meta endpoint: ${metaUrl}`);
          
          const response = await fetch(metaUrl);
          if (!response.ok) {
            console.warn(`DetailsPage: Failed meta fetch from ${addon.name} (${metaUrl}): ${response.statusText}`);
            continue; 
          }
          
          const data = await response.json(); // Expecting StremioMetaResponse structure
          
          if (data && data.meta && hasMinimalProperties(data.meta)) {
             console.log(`DetailsPage: Received meta from ${addon.name}`);
             const currentMeta = data.meta as Meta; // Type assertion

             // Prioritize complete metadata (has description and some visual)
             if (currentMeta.description && (currentMeta.poster || currentMeta.background)) {
               fetchedDetails = currentMeta;
               console.log(`DetailsPage: Found complete metadata from ${addon.name}.`);
               break; // Found good details, stop searching meta
             }
             // Store the best partial metadata found so far
             else if (!partialMeta || 
                      (!partialMeta.description && currentMeta.description) || 
                      (!partialMeta.background && currentMeta.background) ||
                      (!partialMeta.poster && currentMeta.poster) ) 
             {
                console.log(`DetailsPage: Storing partial metadata from ${addon.name}.`);
                partialMeta = currentMeta;
             }
          } else {
             console.warn(`DetailsPage: Invalid or empty meta received from ${addon.name} (${metaUrl})`, data);
          }
        } catch (addonError) {
          console.error(`DetailsPage: Error fetching meta from addon ${addon.name}:`, addonError);
        }
      }

      // If no full details found, use the best partial match or try basic extraction
      if (!fetchedDetails) {
          if (partialMeta) {
              console.log("DetailsPage: Using best partial metadata found.");
              fetchedDetails = partialMeta;
              setPartialMetadata(true);
          } else {
              // --- Try extracting basic info as a last resort ---
              console.log("DetailsPage: No full/partial meta found, attempting basic info extraction from catalogs.");
              triedBasicMeta = true;
              let basicInfo: BasicMeta | null = null;
              // Use prioritizedAddons here as well
              for (const addon of prioritizedAddons) {
                const addonCatalogs = addon.catalogs || [];
                const selectedIds = addon.selectedCatalogIds || addonCatalogs.map(getCatalogUniqueId);
                const filteredCatalogs = addonCatalogs.filter(
                  (catalog) => catalog.type === type && selectedIds.includes(getCatalogUniqueId(catalog))
                );
                
                if (filteredCatalogs.length === 0) continue;
                const manifestUrlParts = addon.manifestUrl.split('/');
                manifestUrlParts.pop();
                const baseUrl = manifestUrlParts.join('/');
                
                for (const catalog of filteredCatalogs) {
                  try {
                    const catalogUrl = `${baseUrl}/catalog/${catalog.type}/${catalog.id}.json`;
                    const response = await fetch(catalogUrl);
                    if (!response.ok) continue;
                    const data = await response.json();
                    if (data && Array.isArray(data.metas)) {
                      const item = data.metas.find((meta: any) => meta.id === id);
                      if (item && item.name && item.id && item.type) { // Basic check
                        basicInfo = {
                          id: item.id, type: item.type, name: item.name, poster: item.poster
                        };
                        console.log(`DetailsPage: Extracted basic info from ${addon.name}/${catalog.id}`);
                        break; 
                      }
                    }
                  } catch (err) { console.warn(`DetailsPage: Error checking catalog ${addon.name}/${catalog.id} for basic info:`, err); }
                }
                if (basicInfo) break; 
              }
              // --- End basic info extraction ---
              if (basicInfo) {
                  console.log("DetailsPage: Using extracted basic metadata.");
                  // Create a minimal Meta object from BasicMeta
                  fetchedDetails = { ...basicInfo, type: basicInfo.type as 'movie' | 'series' }; 
                  setPartialMetadata(true); // Mark as partial
              } else {
                   detailFetchError = "Could not find metadata for this item from any installed addon.";
              }
          }
      }

      // 3. Update State
      setDetails(fetchedDetails); // Set final details (could be full, partial, or basic)
      setPageError(detailFetchError); // Set page error only if detail fetching failed completely
      setLoadingDetails(false);

      // --- If details found AND it's a series, fetch available seasons ---
      if (fetchedDetails && fetchedDetails.type === 'series') {
          // Find the addon that provided the details to get its base URL
          let addonUsedForDetails: any = null;
          if (sourceAddonId) addonUsedForDetails = getAddonById(sourceAddonId);
          if (!addonUsedForDetails) { // Fallback if source ID missing or addon not found
             // Heuristic: assume the first addon in the list provided it, or find based on fetchedDetails content if possible
             // This is imperfect; ideally, the fetching loop would return which addon succeeded.
             addonUsedForDetails = prioritizedAddons[0]; 
          }

          if (addonUsedForDetails) {
              const manifestUrlParts = addonUsedForDetails.manifestUrl.split('/');
              manifestUrlParts.pop();
              const baseUrl = manifestUrlParts.join('/');
              console.log(`DetailsPage: Fetching seasons using base URL from addon: ${addonUsedForDetails.name}`);
              await fetchSeasons(baseUrl, fetchedDetails.type, fetchedDetails.id);
          } else {
              console.warn("DetailsPage: Could not determine addon base URL to fetch seasons.");
              setAvailableSeasons([1]); // Default fallback
          }
      } else {
          // Not a series or no details found, clear seasons/episodes state
          setAvailableSeasons([]);
          setEpisodes([]);
      }
    };

    // --- Decide which fetch function to call ---
    if (canFetchTmdb) {
      console.log("DetailsPage: Detected TMDB ID and configuration, fetching from TMDB.");
      fetchTmdbDetails();
    } else {
      console.log("DetailsPage: Not a TMDB ID or TMDB disabled/unconfigured, fetching from Stremio addons.");
      // Handle case where no addons are installed (if not fetching TMDB)
      if (!isLoadingAddons && (!installedAddons || installedAddons.length === 0)) {
          setPageError("No addons installed to fetch details.");
          setLoadingDetails(false);
          return;
      }
       // Reflect addon context errors if not fetching TMDB
      if (addonContextError) {
          setPageError(`Addon Context Error: ${addonContextError}`);
          // Optionally, still try to fetch if some addons might work?
          // setLoadingDetails(false); // Decided earlier to proceed if possible
      }
      
      fetchStremioDetails(); // Call the original Stremio fetching logic
    }

    // Clean up function (optional)
    return () => {
        // Cancel any ongoing fetches if necessary
    };

  }, [
      id, // Now using the decoded id
      type, 
      sourceAddonId, 
      installedAddons, 
      isLoadingAddons, 
      addonContextError, 
      getAddonById, 
      fetchSeasons, // Keep fetchSeasons for Stremio path
      // Add TMDB dependencies
      tmdbApiKey,
      isTmdbEnabled 
    ]); // Added TMDB context values to dependency array

  // --- useEffect to fetch EPISODES when season changes or details load ---
  useEffect(() => {
    // --- Decide whether to fetch TMDB or Stremio episodes ---
    const isTmdbId = details?.id?.startsWith('tmdb:'); // Check details.id
    const canFetchTmdbEpisodes = isTmdbId && isTmdbEnabled && !!tmdbApiKey;

    if (details && details.type === 'series' && availableSeasons.length > 0) {
        // Ensure selectedSeason is valid
        const seasonToFetch = availableSeasons.includes(selectedSeason) ? selectedSeason : availableSeasons[0];
        if (selectedSeason !== seasonToFetch) {
            setSelectedSeason(seasonToFetch); // Correct the selected season if invalid
            // Return early if season was corrected, the effect will re-run
            return; 
        }

        if (canFetchTmdbEpisodes) {
            // --- Fetch TMDB Episodes ---
            const fetchTmdbEpisodesInternal = async () => {
                setLoadingEpisodes(true);
                setEpisodesError(null);
                setEpisodes([]);

                if (typeof details.id !== 'string' || !details.id.startsWith('tmdb:')) {
                    console.error("DetailsPage (TMDB Episodes): Invalid or non-TMDB ID in details for episode fetching.");
                    setEpisodesError("Cannot fetch episodes: Invalid item ID.");
                    setLoadingEpisodes(false);
                    return;
                }
                const numericId = details.id.substring(5);
                const path = `/tv/${numericId}/season/${seasonToFetch}`;
                const queryParams = { language: 'en-US' };
                
                try {
                    console.log(`DetailsPage (TMDB Episodes): Fetching episodes for ${path} S${seasonToFetch}`);
                    const seasonData = await fetchTmdbData(path, tmdbApiKey, queryParams);
                    
                    if (seasonData && Array.isArray(seasonData.episodes)) {
                         // TODO: Implement transformTmdbEpisodeToLocalFormat
                         const transformedEpisodes: Episode[] = seasonData.episodes.map((ep: any) => 
                            transformTmdbEpisodeToLocalFormat(ep, numericId)
                         );
                         console.log(`DetailsPage (TMDB Episodes): Fetched ${transformedEpisodes.length} episodes for S${seasonToFetch}`);
                         setEpisodes(transformedEpisodes);
                         if (transformedEpisodes.length === 0) {
                             setEpisodesError('No episode data found for this season on TMDB.');
                         }
                    } else {
                         console.warn(`DetailsPage (TMDB Episodes): No episodes array found in response for S${seasonToFetch}`);
                         setEpisodesError('No episode information available for this season.');
                    }

                } catch (err: any) {
                     console.error(`DetailsPage (TMDB Episodes): Error fetching episodes for ${details.id} S${seasonToFetch}:`, err);
                     setEpisodesError(err.message || 'Failed to load episodes for this season from TMDB');
                } finally {
                    setLoadingEpisodes(false);
                }
            };
            fetchTmdbEpisodesInternal();

        } else if (!isTmdbId) { 
             // --- Fetch Stremio Episodes (Existing Logic) ---
             // Find addon base URL again (similar logic as above)
             let addonUsedForDetails: any = null;
             if (sourceAddonId) addonUsedForDetails = getAddonById(sourceAddonId);
             if (!addonUsedForDetails) { 
                 addonUsedForDetails = installedAddons.find(a => a.id === details.id.split(':')[0]); // Try to guess from meta ID prefix
                 if (!addonUsedForDetails) addonUsedForDetails = installedAddons[0]; // Last resort
             }

             if (addonUsedForDetails) {
                 const manifestUrlParts = addonUsedForDetails.manifestUrl.split('/');
                 manifestUrlParts.pop();
                 const baseUrl = manifestUrlParts.join('/');
                 console.log(`DetailsPage: Fetching episodes for S${seasonToFetch} using base URL from addon: ${addonUsedForDetails.name}`);
                 fetchEpisodes(baseUrl, details.type, details.id, seasonToFetch);
             } else {
                 console.error("DetailsPage: Could not determine addon base URL to fetch episodes.");
                 setEpisodesError("Could not determine addon source for episodes.");
             }
         } else {
             console.warn("DetailsPage (Episodes): TMDB ID detected but cannot fetch (check API key/enabled status).");
             setEpisodesError("Cannot fetch TMDB episodes (check configuration).");
             setLoadingEpisodes(false);
             setEpisodes([]);
         }
    }
  }, [
      details, 
      selectedSeason, 
      availableSeasons, 
      installedAddons, 
      sourceAddonId, 
      getAddonById, 
      fetchEpisodes, // Keep for Stremio path
      // Add TMDB dependencies
      tmdbApiKey, 
      isTmdbEnabled
    ]); // Added TMDB deps

  // --- Other useEffects (Animation) ---
  useEffect(() => {
    if (details) { // Animate when details (even partial) are ready
      const timer = setTimeout(() => setContentLoaded(true), 100);
      return () => clearTimeout(timer);
    }
  }, [details]);

  // --- Event Handlers ---
  const openStreamDialog = (target: StreamTarget) => {
    setStreamTarget(target);
    setIsStreamDialogOpen(true);
  };

  const handlePlayClick = () => { // Main play button
    if (!details) return;
    if (details.type === 'series') {
      const targetSeason = availableSeasons.includes(selectedSeason) ? selectedSeason : (availableSeasons[0] || 1);
      const firstEpisodeNum = episodes.length > 0 ? episodes[0].episode : 1;
      openStreamDialog({ season: targetSeason, episode: firstEpisodeNum });
    } else {
      openStreamDialog({}); // Movie
    }
  };

  const handleEpisodeClick = (episode: Episode) => {
    openStreamDialog({ season: episode.season, episode: episode.episode });
  };

  // --- Display Logic ---
  // ... loading/error checks ...

  // Need to calculate this before the return statement
  const episodesToDisplay = episodes; // Use the fetched episodes state directly
  const showEpisodesSection = details && details.type === 'series'; // Show if it's a series

  if (!details) { /* ... handle loading or error states ... */ return null; }

  // --- Render Details --- 
  return (
    <Box sx={{ 
      display: 'flex',
      flexDirection: 'column',
      minHeight: '100vh',
      backgroundColor: '#141414',
      color: 'white',
      position: 'relative'
    }}>
      {/* Background Image with Animation */}
      <Fade 
        in={true} // Always animate in
        timeout={HERO_ANIMATION_DURATION} 
        appear={true} // Animate on first render
      >
        <Box sx={{ 
          position: 'absolute', 
          top: 0, 
          left: 0, 
          right: 0, 
          height: { xs: '70vh', md: '80vh' }, 
          zIndex: 0,
          overflow: 'hidden', // Ensure image doesn't spill out
          '&::after': {
            content: '""',
            position: 'absolute',
            bottom: 0,
            left: 0,
            right: 0,
            height: '75%',
            backgroundImage: 'linear-gradient(to top, #141414, transparent)',
            opacity: contentLoaded ? 1 : 0, // Fade in gradient with content
            transition: 'opacity 1.2s ease-in-out'
          }
        }}>
          {details?.background ? (
            <Box sx={{ 
              width: '100%', 
              height: '100%', 
              position: 'relative',
              transform: contentLoaded ? 'scale(1)' : 'scale(1.05)',
              transition: 'transform 1.5s ease-out',
            }}>
              <Image
                src={getEnhancedImageUrl(details.background)}
                alt={details.name || ''}
                layout="fill"
                objectFit="cover"
                priority
                quality={90}
                sizes="100vw"
                loading="eager"
              />
            </Box>
          ) : details?.poster ? (
            <Box sx={{ 
              width: '100%', 
              height: '100%', 
              position: 'relative',
              transform: contentLoaded ? 'scale(1)' : 'scale(1.05)',
              transition: 'transform 1.5s ease-out',
            }}>
              <Image
                src={getEnhancedImageUrl(details.poster)}
                alt={details.name || ''}
                layout="fill"
                objectFit="cover"
                priority
                quality={90}
                sizes="100vw"
                loading="eager"
                style={{ filter: 'blur(8px) brightness(0.7)' }}
              />
            </Box>
          ) : null}
        </Box>
      </Fade>
      
      {/* Content */}
      <Box sx={{ 
        position: 'relative', 
        zIndex: 1,
        pt: { xs: '35vh', md: '40vh' },
        px: { xs: 3, md: 7.5 },
        display: 'flex',
        flexDirection: 'column',
        flexGrow: 1
      }}>
        {/* Title or Logo with Fade animation */}
        <Fade in={contentLoaded} timeout={ANIMATION_DURATION} style={{ transitionDelay: '100ms' }}>
          <Box>
            {details?.logo ? (
              <Box sx={{ 
                mb: 3, 
                maxWidth: { xs: '70%', sm: '60%', md: '50%', lg: '40%' }
              }}>
                <Image 
                  src={getEnhancedImageUrl(details.logo)}
                  alt={details.name || 'Title logo'}
                  width={500}
                  height={150}
                  layout="responsive"
                  priority
                  quality={95}
                  loading="eager"
                />
              </Box>
            ) : (
              <Typography 
                variant="h2" 
                component="h1" 
                sx={{ 
                  fontWeight: 'bold', 
                  fontSize: { xs: '2rem', sm: '3rem', md: '4rem' },
                  textShadow: '2px 2px 4px rgba(0,0,0,0.5)',
                  mb: 2
                }}
              >
                {details?.name || 'Untitled'}
              </Typography>
            )}
          </Box>
        </Fade>
        
        {/* Partial data warning */}
        {partialMetadata && !pageError && (
          <Fade in={contentLoaded} timeout={ANIMATION_DURATION} style={{ transitionDelay: '200ms' }}>
            <Alert severity="info" sx={{ mb: 3, backgroundColor: '#333', color: 'white' }}>
              Displaying partial information. Some details like description or background might be missing.
            </Alert>
          </Fade>
        )}
        
        {/* Meta info row */}
        <Fade in={contentLoaded} timeout={ANIMATION_DURATION} style={{ transitionDelay: '300ms' }}>
          <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 2, mb: 3, alignItems: 'center' }}>
            {details.releaseInfo && (
              <Typography variant="body1" sx={{ color: 'grey.300' }}>
                {details.releaseInfo}
              </Typography>
            )}
            
            {details.certification && (
              <Box sx={{ 
                border: '1px solid grey.500', 
                px: 1, 
                borderRadius: '4px',
                backgroundColor: 'rgba(0,0,0,0.3)'
              }}>
                <Typography variant="body2">
                  {details.certification}
                </Typography>
              </Box>
            )}
            
            {details.runtime && (
              <Typography variant="body1" sx={{ color: 'grey.300' }}>
                {details.runtime}
              </Typography>
            )}
            
            {details.imdbRating && (
              <Typography variant="body1" sx={{ color: '#f5c518', fontWeight: 'bold' }}>
                ★ {details.imdbRating}
              </Typography>
            )}
          </Box>
        </Fade>
        
        {/* Action buttons */}
        <Fade in={contentLoaded} timeout={ANIMATION_DURATION} style={{ transitionDelay: '400ms' }}>
          <Box sx={{ display: 'flex', gap: 2, mb: 4, flexWrap: 'wrap' }}>
            <Button 
              variant="contained"
              startIcon={<PlayArrow />}
              onClick={handlePlayClick}
              sx={{ 
                backgroundColor: 'white', 
                color: 'black',
                fontWeight: 'bold',
                '&:hover': { backgroundColor: 'rgba(255,255,255,0.75)' }
              }}
            >
              Play
            </Button>
            
            <Button
              variant="contained"
              startIcon={<AddIcon />}
              sx={{ 
                backgroundColor: 'rgba(133,133,133,0.6)', 
                color: 'white',
                '&:hover': { backgroundColor: 'rgba(133,133,133,0.4)' }
              }}
            >
              My List
            </Button>
            
            <Box sx={{ 
              width: '40px', 
              height: '40px', 
              display: 'flex', 
              alignItems: 'center', 
              justifyContent: 'center',
              borderRadius: '50%',
              backgroundColor: 'rgba(42,42,42,0.6)',
              cursor: 'pointer',
              '&:hover': { backgroundColor: 'rgba(42,42,42,0.4)' }
            }}>
              <VolumeOffIcon />
            </Box>
          </Box>
        </Fade>
        
        {/* Description */}
        <Fade in={contentLoaded} timeout={ANIMATION_DURATION} style={{ transitionDelay: '500ms' }}>
          <Box sx={{ maxWidth: '50rem', mb: 5 }}>
            <Typography variant="body1" sx={{ mb: 2, lineHeight: 1.6 }}>
              {details.description || 'No description available'}
            </Typography>
            
            {/* Additional metadata */}
            {(!!details.cast?.length || !!details.director || !!details.genres?.length) && (
              <Box sx={{ mt: 3 }}>
                {details.cast && details.cast.length > 0 && (
                  <Box sx={{ mb: 1, display: 'flex' }}>
                    <Typography variant="body2" sx={{ color: 'grey.500', minWidth: '120px' }}>
                      Cast:
                    </Typography>
                    <Typography variant="body2">
                      {details.cast.slice(0, 5).join(', ')}
                      {details.cast.length > 5 ? ', ...' : ''}
                    </Typography>
                  </Box>
                )}
                
                {details.director && (
                  <Box sx={{ mb: 1, display: 'flex' }}>
                    <Typography variant="body2" sx={{ color: 'grey.500', minWidth: '120px' }}>
                      Director:
                    </Typography>
                    <Typography variant="body2">
                      {Array.isArray(details.director) ? details.director.join(', ') : details.director}
                    </Typography>
                  </Box>
                )}
                
                {details.genres && details.genres.length > 0 && (
                  <Box sx={{ mb: 1, display: 'flex' }}>
                    <Typography variant="body2" sx={{ color: 'grey.500', minWidth: '120px' }}>
                      Genres:
                    </Typography>
                    <Typography variant="body2">
                      {details.genres.join(', ')}
                    </Typography>
                  </Box>
                )}
              </Box>
            )}
          </Box>
        </Fade>
        
        {/* Episodes Section */}
        {showEpisodesSection && (
          <Slide direction="up" in={contentLoaded} timeout={ANIMATION_DURATION} style={{ transitionDelay: '600ms' }}>
            <Box sx={{ width: '100%', mb: 8 }}>
              <Box sx={{ mb: 3, display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end' }}>
                <Typography variant="h4" component="h2" sx={{ fontWeight: 'bold' }}>
                  Episodes
                </Typography>
                
                {availableSeasons.length > 1 && (
                  <FormControl 
                    variant="outlined" 
                    size="small" 
                    sx={{ 
                      minWidth: 120, 
                      '.MuiOutlinedInput-root': {
                        color: 'white',
                        borderColor: 'grey.700',
                        backgroundColor: 'rgba(0,0,0,0.3)',
                      }
                    }}
                  >
                    <Select
                      value={selectedSeason}
                      onChange={(e) => setSelectedSeason(Number(e.target.value))}
                      sx={{ 
                        color: 'white',
                        '.MuiOutlinedInput-notchedOutline': { borderColor: 'grey.700' },
                        '&:hover .MuiOutlinedInput-notchedOutline': { borderColor: 'grey.400' },
                        '.MuiSvgIcon-root': { color: 'white' } 
                      }}
                    >
                      {availableSeasons.map(seasonNum => (
                        <MenuItem key={seasonNum} value={seasonNum}>
                          Season {seasonNum}
                        </MenuItem>
                      ))}
                    </Select>
                  </FormControl>
                )}
              </Box>
              
              <Divider sx={{ borderColor: 'grey.800', mb: 2 }} />
              
              {loadingEpisodes ? (
                <Box sx={{ display: 'flex', justifyContent: 'center', p: 4 }}>
                  <CircularProgress color="inherit" size={32} />
                </Box>
              ) : episodesToDisplay.length > 0 ? (
                <Box>
                  {episodesToDisplay.map((episode, index) => (
                    <Zoom key={episode.id || index} in={contentLoaded} style={{ transitionDelay: `${700 + index * 50}ms` }} timeout={ANIMATION_DURATION}>
                      <div> {/* Wrapper div required for Zoom */} 
                        <EpisodeItem 
                          episode={episode} 
                          onClick={() => handleEpisodeClick(episode)} 
                        />
                      </div>
                    </Zoom>
                  ))}
                </Box>
              ) : (
                <Typography variant="body2" sx={{ color: 'grey.400', fontStyle: 'italic', p:2 }}>
                  {episodesError || 'Episode list not available for this season.'}
                </Typography>
              )}
            </Box>
          </Slide>
        )}
        
        {/* More Like This section */}
        <Fade in={contentLoaded} timeout={ANIMATION_DURATION} style={{ transitionDelay: '800ms' }}>
          <Box sx={{ 
            mb: 8,
            mt: 'auto',
            pt: 5
          }}>
            <Typography variant="h5" component="h2" sx={{ mb: 3, fontWeight: 'bold' }}>
              More Like This
            </Typography>
            
            <Typography variant="body2" sx={{ color: 'grey.400', fontStyle: 'italic' }}>
              Similar content recommendations will appear here
            </Typography>
          </Box>
        </Fade>
      </Box>
      
      {/* Render the Stream Dialog with Grow transition */}
      <Grow in={isStreamDialogOpen} timeout={500}> 
        <div>
          <StreamDialog
            open={isStreamDialogOpen}
            onClose={() => setIsStreamDialogOpen(false)}
            TransitionComponent={Transition}
            keepMounted
            contentType={String(type)}
            contentId={String(id)}
            season={streamTarget?.season}
            episode={streamTarget?.episode}
            contentName={details?.name}
            initialAddonId={sourceAddonId}
          />
        </div>
      </Grow>
    </Box>
  );
} 