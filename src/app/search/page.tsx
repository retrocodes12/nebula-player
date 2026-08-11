'use client';

import React, { useState, useEffect, useCallback, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import CircularProgress from '@mui/material/CircularProgress';
import Alert from '@mui/material/Alert';
import MediaRow from '@/components/MediaRow';
import { useAddonContext } from '@/context/AddonContext';
import { useTmdbContext } from '@/context/TmdbContext';

// Define interfaces based on existing types in the app
interface AddonCatalog {
  id: string;
  name?: string;
  type: string;
}

interface AddonManifest {
  id: string;
  name: string;
  version: string;
  catalogs?: AddonCatalog[];
}

interface InstalledAddon extends AddonManifest {
  manifestUrl: string;
  selectedCatalogIds?: string[];
}

interface StremioCatalogMeta {
  id: string;
  name: string;
  poster?: string;
  type?: string;
}

interface StremioCatalogResponse {
  metas?: StremioCatalogMeta[];
}

// Unified MediaItem for search results
interface MediaItem {
  id: string; // Stremio ID or tmdb:TMDB_ID
  imageUrl: string;
  alt: string;
  type: 'movie' | 'series' | string; // Standardized type
  source: 'addon' | 'tmdb';
}

// A common ID for the official Cinemeta v3 addon
const CINEMETA_ADDON_ID = 'community.cinemeta'; 
const CINEMETA_BASE_URL = 'https://v3-cinemeta.strem.io';

// TMDB types
const TMDB_IMAGE_BASE_URL = 'https://image.tmdb.org/t/p/';

interface TmdbItem {
  id: number;
  poster_path: string | null;
  backdrop_path: string | null;
  title?: string;
  name?: string;
  media_type: 'movie' | 'tv' | 'person';
  overview?: string;
  vote_average?: number;
  vote_count?: number;
}

interface TmdbSearchResponse {
  page: number;
  results: TmdbItem[];
  total_pages: number;
  total_results: number;
}

function SearchPageContent() {
  const searchParams = useSearchParams();
  const query = searchParams.get('q') || '';
  
  const {
    installedAddons,
    isLoading: isLoadingAddons,
    error: addonContextError
  } = useAddonContext();

  const {
    tmdbApiKey,
    isTmdbEnabled,
    isLoadingKey: isLoadingTmdbKey
  } = useTmdbContext();

  const [allSearchResults, setAllSearchResults] = useState<MediaItem[]>([]);
  const [isLoadingSearch, setIsLoadingSearch] = useState<boolean>(true);
  const [pageError, setPageError] = useState<string | null>(null);
  const [currentSearchSource, setCurrentSearchSource] = useState<'tmdb' | 'addons' | 'cinemeta' | null>(null);

  const getCatalogUniqueId = (catalog: AddonCatalog) => `${catalog.type}/${catalog.id}`;
  
  useEffect(() => {
    if (addonContextError) {
        setPageError(`Addon context error: ${addonContextError}`);
    }
  }, [addonContextError]);

  const transformTmdbItemToMediaItem = useCallback((item: TmdbItem): MediaItem | null => {
    if (item.media_type === 'person') return null;

    // Apply rating and vote count filter for movies and TV shows
    if (item.media_type === 'movie' || item.media_type === 'tv') {
      const voteAverage = item.vote_average || 0;
      const voteCount = item.vote_count || 0;
      // Thresholds - can be adjusted
      const MIN_VOTE_AVERAGE = 4.0;
      const MIN_VOTE_COUNT = 10;

      if (voteAverage < MIN_VOTE_AVERAGE || voteCount < MIN_VOTE_COUNT) {
        // console.log(`SearchPage: Filtering out TMDB item due to low rating/votes: ${item.title || item.name} (Avg: ${voteAverage}, Count: ${voteCount})`);
        return null;
      }
    }

    if (!item.poster_path && !item.backdrop_path) return null;

    let itemType: 'movie' | 'series';
    if (item.media_type === 'movie') itemType = 'movie';
    else if (item.media_type === 'tv') itemType = 'series';
    else return null;

    return {
      id: `tmdb:${item.id}`,
      imageUrl: item.poster_path 
        ? `${TMDB_IMAGE_BASE_URL}w500${item.poster_path}`
        : `${TMDB_IMAGE_BASE_URL}w780${item.backdrop_path}`,
      alt: item.title || item.name || 'TMDB Result',
      type: itemType,
      source: 'tmdb',
    };
  }, []);

  const performTmdbSearch = useCallback(async (searchQuery: string, apiKey: string) => {
    setIsLoadingSearch(true);
    setPageError(null);
    setAllSearchResults([]);
    setCurrentSearchSource('tmdb');
    console.log(`SearchPage: Searching TMDB for "${searchQuery}"`);

    try {
      const searchUrl = `https://api.themoviedb.org/3/search/multi?api_key=${apiKey}&query=${encodeURIComponent(searchQuery)}&language=en-US&page=1&include_adult=false`;
      const response = await fetch(searchUrl);
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({ message: response.statusText }));
        throw new Error(`TMDB API error: ${errorData.message || response.statusText} (${response.status})`);
      }
      const data: TmdbSearchResponse = await response.json();
      
      const tmdbMediaItems = data.results
        .map(transformTmdbItemToMediaItem)
        .filter((item): item is MediaItem => item !== null);

      setAllSearchResults(tmdbMediaItems);
      if (tmdbMediaItems.length === 0) {
        setPageError(`No results found for "${searchQuery}" on TMDB.`);
      }
    } catch (err: any) {
      console.error("SearchPage: Error searching TMDB:", err);
      setPageError(`Failed to search TMDB: ${err.message}`);
      setAllSearchResults([]);
    } finally {
      setIsLoadingSearch(false);
    }
  }, [transformTmdbItemToMediaItem]);

  const performAddonSearch = useCallback(async (searchQuery: string) => {
    setIsLoadingSearch(true);
    setPageError(null);
    setAllSearchResults([]);
    
    const cinemetaAddon = installedAddons.find(addon => 
      addon.id === CINEMETA_ADDON_ID || addon.name?.toLowerCase().includes('cinemeta')
    );
    
    const searchPromises: Promise<MediaItem[]>[] = [];

    if (cinemetaAddon) {
      setCurrentSearchSource('cinemeta');
      console.log("SearchPage: Cinemeta addon found. Searching only Cinemeta.");
      const typesToSearch: ('movie' | 'series')[] = ['movie', 'series'];
      typesToSearch.forEach(type => {
        const searchUrl = `${CINEMETA_BASE_URL}/catalog/${type}/top/search=${encodeURIComponent(searchQuery)}.json`;
        searchPromises.push(
          fetch(searchUrl)
            .then(res => {
              if (!res.ok) throw new Error(`HTTP error ${res.status} for ${searchUrl}`);
              return res.json() as Promise<StremioCatalogResponse>;
            })
            .then(data => {
              if (data?.metas && data.metas.length > 0) {
                return data.metas
                  .filter(meta => meta.poster && (meta.type === 'movie' || meta.type === 'series')) 
                  .map(meta => ({
                    id: meta.id,
                    imageUrl: meta.poster!,
                    alt: meta.name || meta.id,
                    type: meta.type as 'movie' | 'series',
                    source: 'addon' as 'addon'
                  }));
              }
              return [];
            })
            .catch(err => {
              console.error(`SearchPage: Error searching Cinemeta ${type}/top:`, err);
              return []; 
            })
        );
      });
    } else {
      setCurrentSearchSource('addons');
      console.log("SearchPage: Cinemeta not found. Searching selected catalogs of other installed addons.");
      installedAddons.forEach(addon => {
        if (!addon.catalogs || addon.catalogs.length === 0) return;
        
        const selectedCatalogIds = addon.selectedCatalogIds || addon.catalogs.map(getCatalogUniqueId);
        if (selectedCatalogIds.length === 0) return;

        const baseUrl = addon.manifestUrl.substring(0, addon.manifestUrl.lastIndexOf('/'));
        
        addon.catalogs.forEach(catalog => {
          const catalogFullId = getCatalogUniqueId(catalog);
          if (!selectedCatalogIds.includes(catalogFullId)) return;
          if (catalog.type !== 'movie' && catalog.type !== 'series') return;

          const searchUrl = `${baseUrl}/catalog/${catalog.type}/${catalog.id}/search=${encodeURIComponent(searchQuery)}.json`;
          searchPromises.push(
            fetch(searchUrl)
              .then(res => {
                if (!res.ok) throw new Error(`HTTP error ${res.status} for ${searchUrl}`);
                return res.json() as Promise<StremioCatalogResponse>;
              })
              .then(data => {
                if (data?.metas && data.metas.length > 0) {
                  return data.metas
                    .filter(meta => meta.poster && (meta.type === 'movie' || meta.type === 'series'))
                    .map(meta => ({
                      id: meta.id,
                      imageUrl: meta.poster!,
                      alt: meta.name || meta.id,
                      type: meta.type as 'movie' | 'series',
                      source: 'addon' as 'addon'
                    }));
                }
                return [];
              })
              .catch(err => {
                console.error(`SearchPage: Error searching ${addon.name} - ${catalog.name || catalog.id}:`, err);
                return [];
              })
          );
        });
      });
    }

    if (searchPromises.length === 0 && !cinemetaAddon) {
        setPageError("No searchable (movie/series) catalogs found in installed addons.");
        setIsLoadingSearch(false);
        setAllSearchResults([]);
        return;
    }
    
    try {
      const resultsFromAllPromises = await Promise.all(searchPromises);
      const combinedResults = resultsFromAllPromises.flat();
      
      const uniqueResults: MediaItem[] = [];
      const seenIds = new Set<string>();
      for (const item of combinedResults) {
        if (!seenIds.has(item.id)) {
          uniqueResults.push(item);
          seenIds.add(item.id);
        }
      }
      setAllSearchResults(uniqueResults);
      
      if (uniqueResults.length === 0) {
        setPageError(`No results found for "${searchQuery}" from ${currentSearchSource === 'cinemeta' ? 'Cinemeta' : 'installed addons'}.`);
      }
    } catch (err) {
      console.error("SearchPage: Error during addon Promise.all execution:", err);
      setPageError('An error occurred while aggregating addon search results');
    } finally {
      setIsLoadingSearch(false);
    }
  }, [installedAddons, getCatalogUniqueId]);

  useEffect(() => {
    if (!query) {
      setIsLoadingSearch(false);
      setAllSearchResults([]);
      setPageError(null);
      setCurrentSearchSource(null);
      return;
    }

    if (isLoadingAddons || isLoadingTmdbKey) {
      setIsLoadingSearch(true);
      return;
    }
    
    if (isTmdbEnabled && tmdbApiKey) {
      performTmdbSearch(query, tmdbApiKey);
    } else if (installedAddons.length > 0) {
      performAddonSearch(query);
    } else {
      setPageError("Search unavailable. Please enable TMDB with an API key or install an addon.");
      setIsLoadingSearch(false);
      setAllSearchResults([]);
      setCurrentSearchSource(null);
    }
  }, [
    query, 
    installedAddons, 
    isLoadingAddons, 
    tmdbApiKey, 
    isTmdbEnabled, 
    isLoadingTmdbKey
  ]);

  const resultsByType: Record<string, MediaItem[]> = {};
  allSearchResults.forEach(item => {
    const typeKey = item.type || 'other';
    if (!resultsByType[typeKey]) {
      resultsByType[typeKey] = [];
    }
    resultsByType[typeKey].push(item);
  });

  const showOverallLoading = isLoadingAddons || isLoadingTmdbKey || isLoadingSearch;

  const getSearchSourceMessage = () => {
    if (!query || showOverallLoading || pageError) return null;
    if (currentSearchSource === 'tmdb') return 'Showing results from TMDB.';
    if (currentSearchSource === 'cinemeta') return 'Showing results from Cinemeta.';
    if (currentSearchSource === 'addons') return 'Showing results from installed addons.';
    return null;
  };
  const searchSourceMessage = getSearchSourceMessage();

  return (
    <Box sx={{ pt: 12, px: { xs: 2, md: 7.5 }, minHeight: '100vh', backgroundColor: '#141414' }}>
      <Typography variant="h4" sx={{ color: 'white', mb: 1 }}>
        Search Results {query ? `for "${query}"` : ''}
      </Typography>
      
      {searchSourceMessage && (
          <Typography variant="caption" sx={{color: 'grey.500', mb:3, display: 'block'}}>
              {searchSourceMessage}
          </Typography>
      )}
      
      {showOverallLoading && (
        <Box sx={{ display: 'flex', justifyContent: 'center', mt: 8 }}>
          <CircularProgress sx={{ color: 'red' }} />
        </Box>
      )}
      
      {pageError && !showOverallLoading && (
        <Alert 
          severity={
            pageError.startsWith("No results found") || 
            pageError.startsWith("No addons installed") ||
            pageError.startsWith("Search unavailable") 
            ? "info" 
            : "warning"
          } 
          sx={{ mt: 2, backgroundColor: '#333', color: 'white' }}
        >
          {pageError}
        </Alert>
      )}

      {!showOverallLoading && !pageError && allSearchResults.length === 0 && query && (
        <Alert severity="info" sx={{ mt: 2, backgroundColor: '#333', color: 'white' }}>
          No results found for "${query}". Please try a different search term.
        </Alert>
      )}

      {!showOverallLoading && Object.keys(resultsByType).length > 0 && (
        <>
          {Object.entries(resultsByType).map(([type, items], index, arr) => {
            if (items.length === 0) return null;
            const isLastType = index === arr.length - 1;
            
            const imageTypeForRow = 'poster';

            return (
              <Box 
                key={type} 
                sx={{ mb: isLastType ? 0 : 4 }} 
              >
                <Typography variant="h5" sx={{ color: 'white', mb: 2, textTransform: 'capitalize' }}>
                  {type === 'movie' ? 'Movies' : type === 'series' ? 'TV Shows' : type}
                </Typography>
                <MediaRow 
                  title=""
                  items={items} 
                  disableBottomMargin={isLastType}
                  imageType={imageTypeForRow} 
                  disableNegativeTopMargin={true}
                />
              </Box>
            );
          })}
        </>
      )}
    </Box>
  );
}

export default function SearchPage() {
  return (
    <Suspense
      fallback={
        <Box sx={{ pt: 12, display: 'flex', justifyContent: 'center', minHeight: '100vh', backgroundColor: '#141414' }}>
          <CircularProgress sx={{ color: 'red' }} />
        </Box>
      }
    >
      <SearchPageContent />
    </Suspense>
  );
} 