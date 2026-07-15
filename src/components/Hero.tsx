'use client';

import React, { useState, useEffect, useCallback, useRef } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
// Removed MUI icons, using downloaded SVGs
// import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined'; 
// import PlayArrowIcon from '@mui/icons-material/PlayArrow'; 
import Image from 'next/image';
import Head from 'next/head';
import { useRouter } from 'next/navigation';
import StreamDialog from '../components/StreamDialog';

// Extended StremioMeta interface to include hero-specific fields
interface HeroMeta {
  id: string;
  type: string;
  name: string;
  poster?: string;
  background?: string;
  logo?: string;
  description?: string;
  releaseInfo?: string;
  imdbRating?: string;
  runtime?: string;
  genres?: string[];
  posterShape?: 'square' | 'poster' | 'landscape';
}

// Addon interfaces (matching those in page.tsx)
interface AddonCatalog {
  type: string;
  id: string;
  name?: string;
}

interface AddonManifest {
  id: string;
  version: string;
  name: string;
  description?: string;
  resources?: (string | { name: string; types?: string[]; idPrefixes?: string[] })[];
  types?: string[];
  catalogs?: AddonCatalog[];
}

interface InstalledAddon extends AddonManifest {
  manifestUrl: string;
  selectedCatalogIds?: string[];
}

// Simple Top 10 Badge Component (using downloaded SVGs)
const Top10Badge = () => (
  <Box sx={{ display: 'flex', alignItems: 'center', position: 'relative', width: '36px', height: '36px' }}>
    {/* Stack the SVG parts. Adjust positioning if needed based on actual SVG content */}
    <img src="/assets/images/top10-icon-1.svg" alt="" style={{ position: 'absolute' }} />
    <img src="/assets/images/top10-icon-2.svg" alt="" style={{ position: 'absolute' }} />
    <img src="/assets/images/top10-icon-3.svg" alt="" style={{ position: 'absolute' }} />
    <img src="/assets/images/top10-icon-4.svg" alt="" style={{ position: 'absolute' }} />
    <img src="/assets/images/top10-icon-5.svg" alt="" style={{ position: 'absolute' }} />
    <img src="/assets/images/top10-icon-6.svg" alt="Top 10" style={{ position: 'absolute' }} />
  </Box>
);

// Image preloader component that loads images in the background
const ImagePreloader = ({ imageUrls }: { imageUrls: string[] }) => {
  return (
    <div style={{ display: 'none' }}>
      {imageUrls.map((url, index) => (
        <img key={index} src={url} alt="" />
      ))}
    </div>
  );
};

// Helper function to enhance image URLs - add it before the Hero component declaration
const getEnhancedImageUrl = (url: string): string => {
  if (!url) return '';
  
  // Convert metahub background URLs from medium to large
  if (url.includes('images.metahub.space/background/medium/')) {
    return url.replace('/background/medium/', '/background/large/');
  }
  
  // Convert metahub poster URLs from medium to large if needed
  if (url.includes('images.metahub.space/poster/medium/')) {
    return url.replace('/poster/medium/', '/poster/large/');
  }
  
  // Convert metahub logo URLs from medium to large if needed
  if (url.includes('images.metahub.space/logo/medium/')) {
    return url.replace('/logo/medium/', '/logo/large/');
  }
  
  return url;
};

const HERO_ROTATION_INTERVAL = 15000; // 15 seconds
const MAX_HERO_ITEMS = 10; // Increased from 5 to 10 for more variety

const Hero: React.FC = () => {
  const router = useRouter();
  const [heroItems, setHeroItems] = useState<HeroMeta[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [fadeIn, setFadeIn] = useState(true);
  
  // Add state for the stream dialog
  const [isStreamDialogOpen, setIsStreamDialogOpen] = useState(false);
  const [streamContentType, setStreamContentType] = useState<string>('');
  const [streamContentId, setStreamContentId] = useState<string>('');
  const [streamContentName, setStreamContentName] = useState<string>('');
  
  const rotationTimerRef = useRef<NodeJS.Timeout | null>(null);
  const imagesPreloaded = useRef<boolean>(false);

  // Fallback data in case we can't fetch from catalogs
  const fallbackHeroData = {
    backgroundImage: '/assets/images/hero-background-new.png',
    titleLogo: '/assets/images/hero-title-logo.png',
    top10Text: 'Türkiye\'de Bugün 4 Numara',
    description: 'Küçük yaşta başının çaresine bakmayı öğrenen ve çok çalışarak iş dünyasında önemli bir konuma gelen Emir, bir gün sokak şarkıcısı bir kızla karşılaşır ve hayatı değişir.'
  };

  // Get URLs of all images to preload
  const getImagesToPreload = useCallback(() => {
    const imagesToPreload: string[] = [];
    
    // Add all background images to preload
    heroItems.forEach(item => {
      if (item.background) {
        imagesToPreload.push(getEnhancedImageUrl(item.background));
      }
      if (item.logo) {
        imagesToPreload.push(getEnhancedImageUrl(item.logo));
      }
      if (item.poster) {
        imagesToPreload.push(getEnhancedImageUrl(item.poster));
      }
    });
    
    return imagesToPreload;
  }, [heroItems]);

  const rotateHero = useCallback(() => {
    setFadeIn(false); // Start fade out
    
    // After fade out animation completes, change content and fade in
    setTimeout(() => {
      setCurrentIndex((prevIndex) => (prevIndex + 1) % heroItems.length);
      setFadeIn(true);
    }, 500); // Half a second for fade out
  }, [heroItems.length]);

  useEffect(() => {
    const fetchHeroContent = async () => {
      setIsLoading(true);
      setError(null);
      
      try {
        // Load installed addons
        const storedAddons = localStorage.getItem('installedAddons');
        if (!storedAddons) {
          console.log("No addons installed for hero content");
          setIsLoading(false);
          return;
        }

        const loadedAddons = JSON.parse(storedAddons) as InstalledAddon[];
        if (!loadedAddons.length) {
          setIsLoading(false);
          return;
        }

        // Find a suitable addon for hero content (preferably movie or series)
        const potentialHeroAddons = loadedAddons.filter((addon: InstalledAddon) => 
          addon.catalogs?.some((catalog: AddonCatalog) => 
            (catalog.type === 'movie' || catalog.type === 'series') && 
            (addon.selectedCatalogIds?.includes(`${catalog.type}/${catalog.id}`))
          )
        );

        if (!potentialHeroAddons.length) {
          console.log("No suitable catalog for hero content");
          setIsLoading(false);
          return;
        }

        // Collect hero items from various catalogs
        const allHeroItems: HeroMeta[] = [];
        const fetchPromises: Promise<void>[] = [];
        const allRawData: any[] = []; // Store all raw catalog data for fallback use

        // Use all available addons instead of just 3
        for (const selectedAddon of potentialHeroAddons) {
          // Find all suitable catalogs from the selected addon
          const heroTypeCatalogs = selectedAddon.catalogs!.filter((catalog: AddonCatalog) => 
            (catalog.type === 'movie' || catalog.type === 'series') && 
            selectedAddon.selectedCatalogIds?.includes(`${catalog.type}/${catalog.id}`)
          );

          if (!heroTypeCatalogs.length) continue;

          // Process all catalogs instead of picking just one
          for (const selectedCatalog of heroTypeCatalogs) {
            // Create fetch promise
            const baseUrl = selectedAddon.manifestUrl.substring(0, selectedAddon.manifestUrl.lastIndexOf('/'));
            const catalogUrl = `${baseUrl}/catalog/${selectedCatalog.type}/${selectedCatalog.id}.json`;
            
            console.log(`Fetching from: ${catalogUrl} (${selectedAddon.name} - ${selectedCatalog.name || selectedCatalog.id})`);
            
            const fetchPromise = fetch(catalogUrl)
              .then(response => {
                if (!response.ok) throw new Error(`Failed to fetch: ${response.statusText}`);
                return response.json();
              })
              .then(data => {
                if (!data?.metas?.length) {
                  console.log(`No items found in ${selectedCatalog.type}/${selectedCatalog.id}`);
                  return;
                }
                
                // Store raw data for possible fallback use
                allRawData.push(data);
                
                console.log(`Found ${data.metas.length} total items in catalog ${selectedCatalog.type}/${selectedCatalog.id}`);
                
                // Filter for items with background images if possible
                const itemsWithBackgrounds = data.metas.filter((meta: HeroMeta) => meta.background);
                console.log(`Of which ${itemsWithBackgrounds.length} have background images`);
                
                // Prioritize items with backgrounds, but use others if needed
                const potentialItems = itemsWithBackgrounds.length >= 4 
                  ? itemsWithBackgrounds 
                  : data.metas;
                
                // Take up to 4 items from each catalog (increased from 2)
                const randomItems = potentialItems
                  .sort(() => 0.5 - Math.random()) // Shuffle
                  .slice(0, 4); 
                
                // Log what we found and are adding
                console.log(`Adding up to ${randomItems.length} items from ${selectedCatalog.type}/${selectedCatalog.id}`);
                
                // Add items ensuring we have a diverse set
                randomItems.forEach((item: HeroMeta) => {
                  // Check if this item already exists
                  if (!allHeroItems.some(existingItem => existingItem.id === item.id)) {
                    // Only add items with description and background for better hero display
                    if (item.background && item.description) {
                      allHeroItems.push(item);
                      console.log(`Added item: ${item.name} (${item.id})`);
                    } else {
                      console.log(`Skipped item without background/description: ${item.name}`);
                    }
                  } else {
                    console.log(`Skipped duplicate item: ${item.name}`);
                  }
                });
              })
              .catch(err => {
                console.error(`Error fetching catalog ${selectedCatalog.type}/${selectedCatalog.id}: ${err.message}`);
              });
            
            fetchPromises.push(fetchPromise);
          }
        }

        // Wait for all fetches to complete
        await Promise.all(fetchPromises);
        
        // Get the final count of items
        console.log(`Found a total of ${allHeroItems.length} suitable hero items`);
        
        // Shuffle to randomize the order and get varied content each time
        const shuffledItems = [...allHeroItems].sort(() => 0.5 - Math.random());
        
        // Limit to a reasonable number of hero items
        const limitedHeroItems = shuffledItems.slice(0, MAX_HERO_ITEMS);
        
        if (limitedHeroItems.length > 0) {
          console.log(`Final hero rotation will show ${limitedHeroItems.length} items`);
          setHeroItems(limitedHeroItems);
          setCurrentIndex(0);
        } else {
          console.warn("No suitable hero items found with all requirements");
          
          // As a fallback, try again with less strict requirements
          // Combine all metas from all raw data that was fetched
          const allMetas = allRawData.flatMap(data => data.metas || []);
          
          if (allMetas.length > 0) {
            // Try to get any items with at least a name
            const fallbackItems = allMetas
              .filter((item: HeroMeta) => item.name && (item.background || item.poster))
              .sort(() => 0.5 - Math.random())
              .slice(0, 5);
              
            console.log(`Using ${fallbackItems.length} fallback items without full metadata`);
            setHeroItems(fallbackItems);
            setCurrentIndex(0);
          }
        }
      } catch (err) {
        console.error("Error fetching hero content:", err);
        setError("Failed to load hero content");
      } finally {
        setIsLoading(false);
      }
    };
    
    fetchHeroContent();
    
    // Clean up rotation timer on unmount
    return () => {
      if (rotationTimerRef.current) {
        clearInterval(rotationTimerRef.current);
      }
    };
  }, []);
  
  // Set up rotation timer when hero items are loaded
  useEffect(() => {
    if (heroItems.length > 1) {
      // Start the rotation
      rotationTimerRef.current = setInterval(rotateHero, HERO_ROTATION_INTERVAL);
      
      // Clear on unmount
      return () => {
        if (rotationTimerRef.current) {
          clearInterval(rotationTimerRef.current);
          rotationTimerRef.current = null;
        }
      };
    }
  }, [heroItems, rotateHero]);

  // Preload images when hero items are loaded
  useEffect(() => {
    if (heroItems.length > 0 && !imagesPreloaded.current) {
      // Set the flag so we only preload once
      imagesPreloaded.current = true;
      console.log("Preloading all hero images for smooth transitions");
    }
  }, [heroItems]);

  // Current hero content (or null if none available)
  const heroContent = heroItems.length > 0 ? heroItems[currentIndex] : null;
  
  // Get next hero item for preloading
  const nextIndex = heroItems.length > 0 ? (currentIndex + 1) % heroItems.length : -1;
  const nextHeroContent = nextIndex >= 0 ? heroItems[nextIndex] : null;
  
  // Derived hero data
  const displayData = {
    backgroundImage: heroContent?.background ? getEnhancedImageUrl(heroContent.background) : fallbackHeroData.backgroundImage,
    title: heroContent?.name || "",
    description: heroContent?.description || fallbackHeroData.description,
    logoImage: heroContent?.logo ? getEnhancedImageUrl(heroContent.logo) : fallbackHeroData.titleLogo,
  };

  // All images to preload for smooth transitions
  const imagesToPreload = getImagesToPreload();

  // Update navigation functions
  const handlePlayClick = () => {
    if (!heroContent) return;
    
    if (heroContent.type === 'series') {
      // For series, navigate to details page where they can select episodes
      router.push(`/details/${heroContent.type}/${heroContent.id}`);
    } else {
      // For movies, open the stream dialog directly
      setStreamContentType(heroContent.type);
      setStreamContentId(heroContent.id);
      setStreamContentName(heroContent.name);
      setIsStreamDialogOpen(true);
      
      // Pause the hero rotation while dialog is open
      if (rotationTimerRef.current) {
        clearInterval(rotationTimerRef.current);
        rotationTimerRef.current = null;
      }
    }
  };

  const handleMoreInfoClick = () => {
    if (!heroContent) return;
    
    // Navigate to the details page for this content
    router.push(`/details/${heroContent.type}/${heroContent.id}`);
  };

  // Add handler to restart rotation when dialog closes
  const handleStreamDialogClose = () => {
    setIsStreamDialogOpen(false);
    
    // Restart the rotation if we have multiple hero items
    if (heroItems.length > 1 && !rotationTimerRef.current) {
      rotationTimerRef.current = setInterval(rotateHero, HERO_ROTATION_INTERVAL);
    }
  };

  return (
    <>
      {/* Preload all images using link tags */}
      <Head>
        {imagesToPreload.map((imageUrl, index) => (
          <link key={`preload-${index}`} rel="preload" as="image" href={imageUrl} />
        ))}
      </Head>
    
      <Box sx={{ 
        position: 'relative', 
        height: {xs: '80vh', sm: '90vh', md: '90vh'},
        overflow: 'hidden',
        mb: 0, // Remove bottom margin to reduce gap with first row
        maxHeight: '85vh', // Limit maximum height on large screens
        '&::after': { // Add gradient overlay at the bottom
          content: '""',
          position: 'absolute',
          bottom: 0,
          left: 0,
          right: 0,
          height: '100%',
          background: 'linear-gradient(0deg, rgba(20,20,20,1) 0%, rgba(20,20,20,0.8) 15%, rgba(20,20,20,0) 40%)',
          pointerEvents: 'none' // So it doesn't interfere with clicks
        }
      }}>
        {/* Preload next images */}
        {!isLoading && !error && heroItems.length > 0 && (
          <ImagePreloader imageUrls={getImagesToPreload()} />
        )}

        {/* Background Image - Conditionally render and apply fade animation */}
        {!isLoading && !error && heroContent && (
          <Box
            sx={{
              position: 'absolute',
              top: 0,
              left: 0,
              width: '100%',
              height: '100%',
              opacity: fadeIn ? 1 : 0,
              transition: 'opacity 0.5s ease-in-out',
              zIndex: 0
            }}
          >
            <Image
              src={getEnhancedImageUrl(heroContent.background || heroContent.poster || fallbackHeroData.backgroundImage)}
              alt={heroContent.name || 'Featured Title'}
              layout="fill"
              objectFit="cover"
              priority={true}
              quality={90}
            />
          </Box>
        )}

        {/* Title Logo and Content Information */}
        <Box
          sx={{
            position: 'absolute',
            bottom: 0,
            left: 0,
            width: '100%',
            padding: { xs: '1rem', sm: '3rem', md: '4rem' },
            paddingRight: { xs: '1rem', sm: '40%', md: '55%' }, // Make space on the right on larger screens
            zIndex: 1,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'flex-start',
            opacity: fadeIn ? 1 : 0,
            transition: 'opacity 0.5s ease-in-out',
            mb: 0 // Add bottom margin to content for space from bottom of hero
          }}
        >
          {/* Title Logo - Using original logic */}
          <Box sx={{ mb: 2, width: { xs: '60%', sm: '50%', md: '45%' } }}>
            {displayData.logoImage ? (
              <Image
                src={displayData.logoImage}
                alt="Title Logo"
                width={500}
                height={135}
                layout="responsive"
                priority
              />
            ) : (
              <Typography variant="h2" component="h1" fontWeight="bold" sx={{ 
                mb: 2, 
                color: 'white',
                textShadow: '2px 2px 4px rgba(0,0,0,0.5)',
                fontSize: { xs: '2rem', sm: '3rem', md: '3.5rem' }
              }}>
                {displayData.title}
              </Typography>
            )}
          </Box>

          {/* Description - Using original logic */}
          <Typography 
            variant="body1" 
            component="p" 
            sx={{ 
              mb: 3,
              fontSize: { xs: '0.9rem', sm: '1rem', md: '1.1rem' },
              maxWidth: '600px', 
              lineHeight: 1.4,
              color: 'white',
              textShadow: '1px 1px 2px rgba(0,0,0,0.7)'
            }}
          >
            {displayData.description}
          </Typography>

          {/* Action Buttons - Using original logic */}
          <Box sx={{ display: 'flex', gap: 2 }}>
            <Button
              variant="contained"
              startIcon={<img src="/assets/images/play-icon-new.svg" alt="" width={24} height={24} />}
              onClick={handlePlayClick}
              sx={{
                backgroundColor: 'white',
                color: 'black',
                fontWeight: 'bold',
                borderRadius: '4px',
                px: { xs: 2.5, md: 3.75 },
                py: { xs: 1, md: 1.875 },
                fontSize: { xs: '1rem', md: '1.1rem' },
                textTransform: 'none',
                '&:hover': { backgroundColor: 'rgba(255, 255, 255, 0.8)' }
              }}
            >
              Play
            </Button>
            <Button
              variant="contained"
              startIcon={<img src="/assets/images/more-info-icon-new.svg" alt="" width={24} height={24} />}
              onClick={handleMoreInfoClick}
              sx={{
                backgroundColor: 'rgba(109, 109, 110, 0.7)',
                color: 'white',
                fontWeight: 'bold',
                borderRadius: '4px',
                px: { xs: 2.5, md: 3.75 },
                py: { xs: 1, md: 1.875 },
                fontSize: { xs: '1rem', md: '1.1rem' },
                textTransform: 'none',
                '&:hover': { backgroundColor: 'rgba(109, 109, 110, 0.4)' }
              }}
            >
              More Info
            </Button>
          </Box>
        </Box>

        {/* Loading Indicator */}
        {isLoading && (
          <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100%' }}>
            <CircularProgress sx={{ color: 'red' }} />
          </Box>
        )}

        {/* Stream Dialog */}
        <StreamDialog
          open={isStreamDialogOpen}
          contentType={streamContentType}
          contentId={streamContentId}
          contentName={streamContentName}
          onClose={handleStreamDialogClose}
        />
      </Box>
    </>
  );
};

export default Hero; 