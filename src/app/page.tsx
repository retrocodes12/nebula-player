'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { Box, CircularProgress, Typography, Alert } from '@mui/material';
import Hero from '../components/Hero';
import MediaRow from '../components/MediaRow';
import { useAddonContext } from '@/context/AddonContext';
import { useTmdbContext } from '@/context/TmdbContext'; // Import TMDB context

// --- Stremio Types ---
interface StremioAddonCatalog {
  type: string;
  id: string;
  name?: string;
}

interface StremioCatalogResponse {
  metas?: { id: string; name?: string; poster?: string; type?: string }[];
}
// --- End Stremio Types ---

// --- TMDB Types ---
const TMDB_IMAGE_BASE_URL = 'https://image.tmdb.org/t/p/';

interface TmdbItem {
  id: number;
  poster_path: string | null;
  backdrop_path: string | null;
  overview: string;
  vote_average: number;
  // Movie specific
  title?: string;
  release_date?: string;
  // TV specific
  name?: string;
  first_air_date?: string;
  media_type?: 'movie' | 'tv'; // present in multi-search or trending all
}

interface TmdbPagedResponse {
  page: number;
  results: TmdbItem[];
  total_pages: number;
  total_results: number;
}
// --- End TMDB Types ---


// --- Shared Types for MediaRow ---
interface MediaItem {
  id: string;       // Stremio ID (e.g., tt12345) or TMDB ID (e.g., tmdb:123)
  imageUrl: string;
  alt: string;
  type: 'movie' | 'series'; // Standardized type
  source: 'addon' | 'tmdb'; // Distinguish item origin
  _tmdbRawBackdropPath?: string | null; // For TMDB item fallback
  _tmdbRawPosterPath?: string | null;   // For TMDB item fallback
  isLoading?: boolean;    // Flag to indicate if the item is in loading state
}

interface HomepageCatalogRow {
  title: string;
  items: MediaItem[];
  id: string; // Unique ID for the row (e.g., addonId-catalogId or tmdb-trending_movies)
  addonId?: string; // Only for addon-sourced rows
  source: 'addon' | 'tmdb'; // To distinguish the origin
}
// --- End Shared Types ---

const HOMEPAGE_CATALOGS_CACHE_KEY = 'homepageCatalogsCache';
const HOMEPAGE_CONFIG_SIGNATURE_KEY = 'homepageConfigSignature';

// Re-import or define InstalledAddon if not already in scope
// Assuming InstalledAddon is similar to this, adjust if necessary:
interface AddonCatalogSignature {
  type: string;
  id: string;
  name?: string;
}
interface InstalledAddonSignature extends AddonManifestSignature {
  manifestUrl: string;
  selectedCatalogIds?: string[];
}
interface AddonManifestSignature {
  id: string;
  version: string;
  name: string;
  description?: string;
  catalogs?: AddonCatalogSignature[];
  resources?: (string | { name: string; types?: string[]; idPrefixes?: string[] })[];
  types?: string[];
}

// Helper to generate a signature for the current data-fetching configuration
const generateConfigSignature = (
  apiKey: string | null, 
  tmdbEnabled: boolean, 
  addons: InstalledAddonSignature[] | null | undefined // Use the specific type
): string => {
  const addonSignature = addons?.map((a: InstalledAddonSignature) => ({ 
    id: a.id, 
    selected: a.selectedCatalogIds?.sort().join(',') 
  })).sort((x: {id: string}, y: {id: string}) => x.id.localeCompare(y.id)) || [];
  return JSON.stringify({ apiKey, tmdbEnabled, addons: addonSignature });
};

export default function HomePage() {
  // Stremio Addon Context
  const {
    installedAddons,
    isLoading: isLoadingAddons,
    error: addonContextError
  } = useAddonContext();

  // TMDB Context
  const {
    tmdbApiKey,
    isLoadingKey: isLoadingTmdbKey,
    isTmdbEnabled, // Get the enabled status
    // keyError: tmdbKeyError // We can handle this if needed, e.g. disable TMDB section
  } = useTmdbContext();

  const [homepageCatalogs, setHomepageCatalogs] = useState<HomepageCatalogRow[]>([]);
  const [isLoadingPageData, setIsLoadingPageData] = useState<boolean>(true);
  const [pageError, setPageError] = useState<string | null>(null);

  // Wrapped setHomepageCatalogs to also update sessionStorage
  const setHomepageCatalogsWithCache = useCallback((data: HomepageCatalogRow[], currentSignature: string) => {
    setHomepageCatalogs(data);
    if (typeof window !== 'undefined') {
      try {
        sessionStorage.setItem(HOMEPAGE_CATALOGS_CACHE_KEY, JSON.stringify(data));
        sessionStorage.setItem(HOMEPAGE_CONFIG_SIGNATURE_KEY, currentSignature);
        console.log("HomePage: Saved to sessionStorage with signature:", currentSignature);
      } catch (e) {
        console.warn("HomePage: Failed to save homepage catalogs to sessionStorage", e);
      }
    }
  }, []);

  const getStremioCatalogUniqueId = (catalog: StremioAddonCatalog) => `${catalog.type}/${catalog.id}`;

  // --- TMDB Data Fetching Functions --- 
  const fetchTmdbData = async (endpoint: string, apiKey: string): Promise<TmdbItem[]> => {
    let url = `https://api.themoviedb.org/3${endpoint}`;
    if (endpoint.includes('?')) {
      url += `&api_key=${apiKey}&language=en-US&page=1`;
    } else {
      url += `?api_key=${apiKey}&language=en-US&page=1`;
    }
    console.log(`HomePage (TMDB): Fetching ${url}`);
    const response = await fetch(url);
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({ message: response.statusText }));
      throw new Error(`TMDB API error for ${endpoint}: ${errorData.message || response.statusText} (${response.status})`);
    }
    const data: TmdbPagedResponse = await response.json();
    return data.results || [];
  };

  // Function to fetch backdrops for a specific movie/TV item from the /images endpoint
  const fetchTmdbItemBackdrop = async (itemType: 'movie' | 'tv', itemId: number, apiKey: string): Promise<string | null> => {
    try {
      const url = `https://api.themoviedb.org/3/${itemType}/${itemId}/images?api_key=${apiKey}&include_image_language=en,null`;
      
      const response = await fetch(url);
      if (!response.ok) {
        console.warn(`Failed to fetch images for ${itemType}/${itemId}: ${response.status}`);
        return null;
      }
      
      const data = await response.json();
      
      // Find the best backdrop - prioritize by language first (English), then quality
      if (data?.backdrops && data.backdrops.length > 0) {
        // First try to get English backdrops
        const englishBackdrops = data.backdrops.filter(
          (backdrop: any) => backdrop.iso_639_1 === 'en'
        );
        
        // If English backdrops exist, sort and use them
        if (englishBackdrops.length > 0) {
          englishBackdrops.sort((a: any, b: any) => {
            // Sort by vote_average first
            if (a.vote_average !== undefined && b.vote_average !== undefined) {
              return b.vote_average - a.vote_average;
            }
            // Then by vote_count
            if (a.vote_count !== undefined && b.vote_count !== undefined) {
              return b.vote_count - a.vote_count;
            }
            return 0;
          });
          
          return `${TMDB_IMAGE_BASE_URL}original${englishBackdrops[0].file_path}`;
        }
        
        // Fallback to any backdrops (including null language/language-neutral)
        const sortedBackdrops = [...data.backdrops];
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
        // Use original size for the best quality
        return `${TMDB_IMAGE_BASE_URL}original${bestBackdrop.file_path}`;
      }
      
      return null;
    } catch (error) {
      console.error(`Error fetching backdrop for ${itemType}/${itemId}:`, error);
      return null;
    }
  };

  const transformTmdbItemToMediaItem = (item: TmdbItem, typeOverride?: 'movie' | 'series'): MediaItem | null => {
    // We still check if backdrop_path exists as a minimum requirement
    if (!item.backdrop_path && !item.poster_path) return null; // Skip items without any images
    
    let itemType: 'movie' | 'series';
    if (typeOverride) {
        itemType = typeOverride;
    } else if (item.media_type === 'movie') {
        itemType = 'movie';
    } else if (item.media_type === 'tv') {
        itemType = 'series';
    } else if (item.title && item.release_date) { // Heuristic for movie if media_type is missing
        itemType = 'movie';
    } else if (item.name && item.first_air_date) { // Heuristic for TV/series if media_type is missing
        itemType = 'series';
    } else {
        console.warn("HomePage (TMDB): Could not determine type for TMDB item", item);
        return null; // Cannot determine type
    }

    // For TMDB items, imageUrl is initially empty as it will be populated by enhanceRowBackdrops
    // Store original paths for fallback.
    return {
      id: `tmdb:${item.id}`, // Prefix TMDB IDs to avoid collision with Stremio IDs
      imageUrl: '', // Initially empty for TMDB items
      alt: item.title || item.name || 'TMDB Item',
      type: itemType,
      source: 'tmdb',
      _tmdbRawBackdropPath: item.backdrop_path,
      _tmdbRawPosterPath: item.poster_path,
      isLoading: true // TMDB items start in loading state
    };
  };

  const fetchTmdbHomepageCatalogs = async (apiKey: string) => {
    setIsLoadingPageData(true);
    setPageError(null);
    console.log("HomePage: Fetching catalogs from TMDB...");

    const currentSignature = generateConfigSignature(apiKey, true, installedAddons);

    const tmdbCatalogsToFetch = [
      { id: 'trending_movies_week', endpoint: '/trending/movie/week', title: 'Trending Movies', type: 'movie' as const },
      { id: 'popular_movies', endpoint: '/movie/popular', title: 'Popular Movies', type: 'movie' as const },
      { id: 'top_rated_movies', endpoint: '/movie/top_rated', title: 'Top Rated Movies', type: 'movie' as const },
      { id: 'trending_tv_week', endpoint: '/trending/tv/week', title: 'Trending TV Shows', type: 'series' as const },
      {
        id: 'popular_tv',
        endpoint: '/discover/tv?include_adult=false&sort_by=popularity.desc&without_genres=10767',
        title: 'Popular TV Shows',
        type: 'series' as const
      },
      { id: 'top_rated_tv', endpoint: '/tv/top_rated', title: 'Top Rated TV Shows', type: 'series' as const },
    ];

    try {
      const fetchedTmdbRows: HomepageCatalogRow[] = [];
      const promises = tmdbCatalogsToFetch.map(async (tmdbCat) => {
        try {
          const tmdbItems = await fetchTmdbData(tmdbCat.endpoint, apiKey);
          
          // Process TMDB items with basic backdrop/poster paths first
          const basicMediaItems: MediaItem[] = tmdbItems
            .map(item => transformTmdbItemToMediaItem(item, tmdbCat.type))
            .filter((item): item is MediaItem => item !== null);
          
          if (basicMediaItems.length > 0) {
            // Create a row with the basic items - enhanced ones will come later
            fetchedTmdbRows.push({
              id: `tmdb-${tmdbCat.id}`,
              title: `${tmdbCat.title} • TMDB`,
              items: basicMediaItems,
              source: 'tmdb',
            });
          }
        } catch (catError) {
          console.error(`HomePage (TMDB): Error fetching TMDB catalog ${tmdbCat.title}:`, catError);
          // Optionally collect these errors to show a partial error message
        }
      });

      await Promise.all(promises);
      
      // Simple sort for TMDB rows, can be customized
      fetchedTmdbRows.sort((a,b) => a.title.localeCompare(b.title));
      // setHomepageCatalogs(fetchedTmdbRows); // Initial render with empty imageURLs for TMDB items
      // Update state AND cache for initial TMDB rows (without enhanced images yet)
      setHomepageCatalogsWithCache(fetchedTmdbRows, currentSignature);

      // New function to process enhancement of all TMDB rows concurrently
      const enhanceTmdbRowsConcurrently = async (initialRows: HomepageCatalogRow[], apiKeyToUse: string) => {
        const rowEnhancementPromises = initialRows.map(async (row) => {
          if (row.source !== 'tmdb') {
            return row; // Pass through non-TMDB rows
          }

          const itemsToEnhanceInRow = [...row.items]; // Work on a copy for this specific row
          
          const BATCH_SIZE = 3;
          for (let i = 0; i < itemsToEnhanceInRow.length; i += BATCH_SIZE) {
            const batch = itemsToEnhanceInRow.slice(i, i + BATCH_SIZE);
            
            const itemDetailPromises = batch.map(async (item) => {
              // Find the item's current index in itemsToEnhanceInRow to ensure updates apply to the correct object
              // This is important because 'item' here is from the 'batch' slice.
              const originalItemIndex = itemsToEnhanceInRow.findIndex(it => it.id === item.id);

              if (item.source !== 'tmdb' || !item.id.startsWith('tmdb:')) return; // Should already be filtered by row.source

              try {
                const tmdbId = parseInt(item.id.replace('tmdb:', ''));
                if (isNaN(tmdbId)) return;

                const mediaType = item.type === 'movie' ? 'movie' : 'tv';
                const betterBackdropUrl = await fetchTmdbItemBackdrop(mediaType, tmdbId, apiKeyToUse);

                let finalImageUrl = '';
                if (betterBackdropUrl) {
                  finalImageUrl = betterBackdropUrl;
                } else {
                  if (item._tmdbRawBackdropPath) {
                    finalImageUrl = `${TMDB_IMAGE_BASE_URL}original${item._tmdbRawBackdropPath}`;
                  } else if (item._tmdbRawPosterPath) {
                    finalImageUrl = `${TMDB_IMAGE_BASE_URL}w500${item._tmdbRawPosterPath}`;
                  }
                }
                
                // Update the item in the itemsToEnhanceInRow array for this current row
                if (originalItemIndex !== -1 && itemsToEnhanceInRow[originalItemIndex].imageUrl !== finalImageUrl) {
                  itemsToEnhanceInRow[originalItemIndex] = {
                    ...itemsToEnhanceInRow[originalItemIndex],
                    imageUrl: finalImageUrl,
                    isLoading: false // No longer loading once we have a URL
                  };
                }
              } catch (error) {
                console.warn(`Error enhancing backdrop for ${item.id} in row ${row.title}:`, error);
                const currentItemToFallback = itemsToEnhanceInRow[originalItemIndex];
                if (originalItemIndex !== -1 && currentItemToFallback) {
                    let fallbackImageUrlOnError = '';
                    if (currentItemToFallback._tmdbRawBackdropPath) {
                        fallbackImageUrlOnError = `${TMDB_IMAGE_BASE_URL}original${currentItemToFallback._tmdbRawBackdropPath}`;
                    } else if (currentItemToFallback._tmdbRawPosterPath) {
                        fallbackImageUrlOnError = `${TMDB_IMAGE_BASE_URL}w500${currentItemToFallback._tmdbRawPosterPath}`;
                    }
                    if (itemsToEnhanceInRow[originalItemIndex].imageUrl !== fallbackImageUrlOnError) {
                       itemsToEnhanceInRow[originalItemIndex] = { 
                         ...itemsToEnhanceInRow[originalItemIndex], 
                         imageUrl: fallbackImageUrlOnError,
                         isLoading: false // No longer loading even with fallback
                       };
                    }
                }
              }
            });
            
            await Promise.allSettled(itemDetailPromises); // Wait for all items in this batch to be processed
            
            // Add a small delay after each batch for this row to avoid overwhelming the API too quickly
            // Only add delay if there are more batches to come for this row
            if (i + BATCH_SIZE < itemsToEnhanceInRow.length) {
                await new Promise(resolve => setTimeout(resolve, 200));
            }
          }
          return { ...row, items: itemsToEnhanceInRow }; // Return the row with its items enhanced
        });

        const allEnhancedOrOriginalRows = await Promise.all(rowEnhancementPromises);
        // setHomepageCatalogs(allEnhancedOrOriginalRows); // Single state update with all images populated
        // Update state AND cache after TMDB rows are enhanced
        setHomepageCatalogsWithCache(allEnhancedOrOriginalRows, currentSignature);
      };
      
      // Start the enhancement process if there are TMDB rows
      if (fetchedTmdbRows.some(r => r.source === 'tmdb')) {
        enhanceTmdbRowsConcurrently(fetchedTmdbRows, apiKey).catch(error => {
          console.error("HomePage (TMDB): Error during concurrent enhancement of TMDB rows:", error);
          // Potentially set an error state or revert to initial rows if needed
        });
      }

      if (fetchedTmdbRows.length === 0) {
        setPageError("Could not load any content from TMDB. The API might be temporarily unavailable or there's no content for these categories.");
      }

    } catch (error: any) {
      console.error("HomePage (TMDB): Failed to fetch TMDB homepage catalogs:", error);
      setPageError(`Failed to load data from TMDB: ${error.message}`);
    } finally {
      setIsLoadingPageData(false);
    }
  };
  // --- End TMDB Data Fetching Functions ---

  // --- Stremio Addon Data Fetching (Original Logic, adapted) ---
  const fetchStremioHomepageCatalogs = async () => {
    if (!installedAddons || installedAddons.length === 0) {
      console.log("HomePage: No addons installed or loaded yet for Stremio fetching.");
      if (typeof window !== 'undefined') { // Clear cache if no addons
        sessionStorage.removeItem(HOMEPAGE_CATALOGS_CACHE_KEY);
        sessionStorage.removeItem(HOMEPAGE_CONFIG_SIGNATURE_KEY);
      }
      setHomepageCatalogsWithCache([], generateConfigSignature(tmdbApiKey, isTmdbEnabled, installedAddons)); // Cache empty state

      // Only set error if TMDB isn't also an option or has failed
      if (!addonContextError) {
           setPageError("No Stremio addons are currently installed. Please visit the Addons page to install some, or configure TMDB.");
      }
      setIsLoadingPageData(false);
      return;
    }
    
    setIsLoadingPageData(true);
    setPageError(null);
    console.log("HomePage: Fetching catalogs from Stremio Addons...");
    let allFetchedStremioRows: HomepageCatalogRow[] = [];
    const fetchPromises: Promise<void>[] = [];

    const currentSignature = generateConfigSignature(null, false, installedAddons);

    installedAddons.forEach(addon => {
      const addonSelectedCatalogs = addon.catalogs?.filter(catalog => 
        addon.selectedCatalogIds?.includes(getStremioCatalogUniqueId(catalog))
      ) || [];

      if (addonSelectedCatalogs.length > 0) {
        const baseUrl = addon.manifestUrl.substring(0, addon.manifestUrl.lastIndexOf('/'));

        addonSelectedCatalogs.forEach(stremioCatalog => {
          const catalogFullId = getStremioCatalogUniqueId(stremioCatalog);
          let catalogTitle = stremioCatalog.name || `${stremioCatalog.type} ${stremioCatalog.id}`.replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
          
          const lowerCaseName = catalogTitle.toLowerCase();
          const hasMovieWord = lowerCaseName.includes('movie');
          const hasSeriesWord = lowerCaseName.includes('series') || lowerCaseName.includes('tv') || lowerCaseName.includes('show');

          if (stremioCatalog.type === 'movie' && !hasMovieWord) catalogTitle += ' Movies';
          else if (stremioCatalog.type === 'series' && !hasSeriesWord) catalogTitle += ' TV Shows';
          
          catalogTitle = `${catalogTitle} • ${addon.name}`;
          const catalogUrl = `${baseUrl}/catalog/${stremioCatalog.type}/${stremioCatalog.id}.json`;
          
          fetchPromises.push(
            fetch(catalogUrl)
              .then(response => {
                if (!response.ok) throw new Error(`Fetch failed for ${catalogTitle}: ${response.statusText} (${catalogUrl})`);
                return response.json() as Promise<StremioCatalogResponse>;
              })
              .then(data => {
                if (data?.metas && data.metas.length > 0) {
                  const items: MediaItem[] = data.metas
                    .filter(meta => meta.poster && meta.type) // Ensure type is present for Stremio items
                    .map(meta => ({ 
                      id: meta.id!,
                      imageUrl: meta.poster!,
                      alt: meta.name || meta.id!,
                      type: meta.type as 'movie' | 'series', // Assuming type is 'movie' or 'series'
                      source: 'addon', // Add source for Stremio/addon items
                      isLoading: false // Stremio items start with imageUrl ready
                    }));
                  if (items.length > 0) {
                    allFetchedStremioRows.push({ 
                      title: catalogTitle, 
                      items: items, 
                      id: `${addon.id}-${catalogFullId}`,
                      addonId: addon.id,
                      source: 'addon',
                    });
                  }
                }
              })
              .catch(err => {
                console.error(`HomePage (Stremio): Error fetching/processing catalog ${catalogTitle}:`, err);
              })
          );
        });
      }
    });

    try {
      await Promise.all(fetchPromises);
      allFetchedStremioRows.sort((a, b) => a.title.localeCompare(b.title));
      // setHomepageCatalogs(allFetchedStremioRows);
      setHomepageCatalogsWithCache(allFetchedStremioRows, currentSignature);

      if (allFetchedStremioRows.length === 0 && installedAddons.some(a => a.selectedCatalogIds && a.selectedCatalogIds.length > 0)) {
          setPageError("No content could be loaded from the selected Stremio addon catalogs. Check addon configurations or CORS issues.");
      } else if (allFetchedStremioRows.length === 0 && installedAddons.length > 0) {
          setPageError("No Stremio addon catalogs selected to display. Visit the Addons page to enable some.");
      }

    } catch (overallError) {
       console.error("HomePage (Stremio): Error during Promise.all for catalogs:", overallError);
       setPageError("An error occurred while fetching Stremio addon catalog data.");
    } finally {
      setIsLoadingPageData(false);
    }
  };
  // --- End Stremio Addon Data Fetching ---


  useEffect(() => {
    if (addonContextError) {
        setPageError(`Addon loading error: ${addonContextError}`);
    }

    // Try to load from cache first
    if (typeof window !== 'undefined') {
      const cachedDataString = sessionStorage.getItem(HOMEPAGE_CATALOGS_CACHE_KEY);
      const cachedSignature = sessionStorage.getItem(HOMEPAGE_CONFIG_SIGNATURE_KEY);
      const currentSignature = generateConfigSignature(tmdbApiKey, isTmdbEnabled, installedAddons);

      if (cachedDataString && cachedSignature && cachedSignature === currentSignature) {
        try {
          const cachedData = JSON.parse(cachedDataString);
          if (cachedData && Array.isArray(cachedData)) {
            setHomepageCatalogs(cachedData);
            setIsLoadingPageData(false);
            console.log("HomePage: Loaded catalogs from sessionStorage (signature match).");
            return; // Exit early as data is loaded from cache
          }
        } catch (e) {
          console.warn("HomePage: Failed to parse cached homepage catalogs, will re-fetch.", e);
          sessionStorage.removeItem(HOMEPAGE_CATALOGS_CACHE_KEY);
          sessionStorage.removeItem(HOMEPAGE_CONFIG_SIGNATURE_KEY);
        }
      } else if (cachedDataString || cachedSignature) {
        // If cache exists but signature doesn't match or is missing, it's stale.
        console.log("HomePage: Cache signature mismatch or missing. Invalidating cache.");
        sessionStorage.removeItem(HOMEPAGE_CATALOGS_CACHE_KEY);
        sessionStorage.removeItem(HOMEPAGE_CONFIG_SIGNATURE_KEY);
      }
    }

    // Decide whether to fetch from TMDB or Stremio Addons
    if (!isLoadingTmdbKey && !isLoadingAddons) { // Wait until *both* contexts have loaded their initial state
      // Clear previous page error before attempting a new fetch
      setPageError(null);
      const currentSignature = generateConfigSignature(tmdbApiKey, isTmdbEnabled, installedAddons);

      if (tmdbApiKey && isTmdbEnabled) { // Check for API Key AND enabled status
        console.log("HomePage: TMDB API Key found and integration enabled. Fetching from TMDB.");
        fetchTmdbHomepageCatalogs(tmdbApiKey);
      } else {
        // Fallback to Stremio addons if TMDB key missing OR TMDB is disabled
        if (!tmdbApiKey) console.log("HomePage: No TMDB API Key found. Fetching from Stremio Addons.");
        if (tmdbApiKey && !isTmdbEnabled) console.log("HomePage: TMDB integration is disabled. Fetching from Stremio Addons.");
        fetchStremioHomepageCatalogs();
      }
    } else {
        console.log(`HomePage: Waiting for initial context loading... (TMDB Key: ${isLoadingTmdbKey}, Addons: ${isLoadingAddons})`);
        setIsLoadingPageData(true); // Show loading while waiting for contexts
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tmdbApiKey, isTmdbEnabled, isLoadingTmdbKey, installedAddons, isLoadingAddons, addonContextError, setHomepageCatalogsWithCache]); // Added setHomepageCatalogsWithCache and useCallback


  // Combined loading state for UI
  const showLoadingIndicator = isLoadingTmdbKey || isLoadingAddons || isLoadingPageData;

  return (
    <Box>
      <Hero />
      <Box sx={{ pb: 4, backgroundColor: '#141414' }}>
        {showLoadingIndicator && (
          <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '200px' }}>
            <CircularProgress sx={{color: 'red'}} />
          </Box>
        )}

        {!showLoadingIndicator && pageError && (
          <Alert severity="warning" sx={{ mx: { xs: 2, md: 7.5 }, my: 2, backgroundColor: '#333', color: 'white' }}>
            {pageError}
          </Alert>
        )}
        
        {!showLoadingIndicator && !pageError && homepageCatalogs.length === 0 && (
            <Alert severity="info" sx={{ mx: { xs: 2, md: 7.5 }, my: 2, backgroundColor: '#1f1f1f', color: 'white' }}>
                No content to display. Please configure TMDB API key, or install and select Stremio addon catalogs.
            </Alert>
        )}

        {!showLoadingIndicator && homepageCatalogs.length > 0 && (
          homepageCatalogs.map((catalogRow) => (
            <MediaRow 
              key={catalogRow.id} 
              title={catalogRow.title} 
              items={catalogRow.items} 
              addonId={catalogRow.source === 'addon' ? catalogRow.addonId : undefined}
              imageType={catalogRow.source === 'tmdb' ? 'backdrop' : 'poster'} // Use backdrop format for TMDB, poster for addons
              // Pass TMDB ID or Stremio ID appropriately to details page in MediaRow if needed
              // For TMDB items, catalogRow.items[any].id is `tmdb:${tmdb_id}`
            />
          ))
        )}
      </Box>
    </Box>
  );
}
