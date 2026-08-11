'use client';

import React, { createContext, useState, useEffect, useContext, ReactNode, useCallback } from 'react';

// --- Interfaces (Mirroring those in addons/page.tsx) ---
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
  catalogs?: AddonCatalog[];
  resources?: (string | { name: string; types?: string[]; idPrefixes?: string[] })[];
  types?: string[];
}

interface InstalledAddon extends AddonManifest {
  manifestUrl: string;
  selectedCatalogIds?: string[]; // Stores IDs like "movie/top"
}
// --- End Interfaces ---

interface AddonContextType {
  installedAddons: InstalledAddon[];
  isLoading: boolean;
  error: string | null;
  installAddon: (manifestUrl: string) => Promise<void>;
  uninstallAddon: (manifestUrl: string) => void;
  toggleCatalogSelection: (addonManifestUrl: string, catalogId: string) => void;
  getAddonById: (id: string) => InstalledAddon | undefined;
  installSampleAddon: () => Promise<void>;
  isStreamingAddon: (addon: InstalledAddon) => boolean;
}

const AddonContext = createContext<AddonContextType | undefined>(undefined);

// Define a key for local storage for Addons only
const ADDONS_STORAGE_KEY = 'installedAddonsData'; // Renamed to be more specific

// Interface for stored addon data (no longer includes TMDB key)
// interface StoredData {
// addons: InstalledAddon[];
// tmdbKey: string | null; // Removed
// }

export const AddonProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [installedAddons, setInstalledAddons] = useState<InstalledAddon[]>([]);
  // Removed tmdbApiKey state
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  const getCatalogUniqueId = (catalog: AddonCatalog) => `${catalog.type}/${catalog.id}`;

  // Load addons from local storage on mount
  useEffect(() => {
    setIsLoading(true);
    try {
      // First try loading from our new storage key
      let storedAddonsJson = localStorage.getItem(ADDONS_STORAGE_KEY);
      
      // If no data in new key, try loading from the original key
      if (!storedAddonsJson) {
        console.log('AddonContext: No data in new storage key, trying original key');
        storedAddonsJson = localStorage.getItem('installedAddons');
        
        if (storedAddonsJson) {
          console.log('AddonContext: Successfully loaded data from original key');
        }
      }
      
      const loadedAddons: InstalledAddon[] = storedAddonsJson ? JSON.parse(storedAddonsJson) : [];

      // Process addons (ensure selectedCatalogIds exists)
      const processedAddons = loadedAddons.map(addon => ({
        ...addon,
        selectedCatalogIds: addon.selectedCatalogIds || (addon.catalogs?.map(getCatalogUniqueId) || [])
      }));
      setInstalledAddons(processedAddons);

      console.log('AddonContext: Loaded', processedAddons.length, 'addons from storage');
      setError(null);
    } catch (e) {
      console.error("AddonContext: Error loading addons:", e);
      setError('Error loading addons from storage.');
      setInstalledAddons([]);
    } finally {
      setIsLoading(false);
    }
  }, []);

  // Save addons to local storage whenever they change
  useEffect(() => {
    if (!isLoading) {
      try {
        // Save to our new storage key
        localStorage.setItem(ADDONS_STORAGE_KEY, JSON.stringify(installedAddons));
        
        // Also save to the original 'installedAddons' key for backward compatibility
        localStorage.setItem('installedAddons', JSON.stringify(installedAddons));
        
        console.log('AddonContext: Saved', installedAddons.length, 'addons to localStorage');
      } catch (e) {
        console.error("AddonContext: Error saving addons:", e);
        setError('Error saving addon preferences.');
      }
    }
  }, [installedAddons, isLoading]);

  const installAddon = useCallback(async (manifestUrl: string) => {
    setError(null);
    if (!manifestUrl || !manifestUrl.endsWith('manifest.json')) {
      throw new Error('Invalid manifest URL (must end with manifest.json).');
    }
    if (installedAddons.some(a => a.manifestUrl === manifestUrl)) {
      throw new Error('Addon from this URL is already installed.');
    }
    
    try {
      const res = await fetch(manifestUrl);
      if (!res.ok) throw new Error(`HTTP error ${res.status}`);
      const manifest = await res.json() as AddonManifest;
      if (!manifest.id || !manifest.version || !manifest.name) throw new Error('Manifest is missing required fields (id, version, name).');
      
      const newAddon: InstalledAddon = {
        ...manifest,
        manifestUrl: manifestUrl,
        selectedCatalogIds: manifest.catalogs?.map(getCatalogUniqueId) || [],
      };
      
      setInstalledAddons(prev => [...prev, newAddon]);
    } catch (err: any) {
      console.error("AddonContext: Failed to install addon:", err);
      setError(`Install Failed: ${err.message}`);
      throw err;
    }
  }, [installedAddons]);

  const uninstallAddon = useCallback((manifestUrl: string) => {
    setInstalledAddons(prev => prev.filter(a => a.manifestUrl !== manifestUrl));
  }, []);

  const toggleCatalogSelection = useCallback((addonManifestUrl: string, catalogId: string) => {
    setInstalledAddons(prevAddons => 
      prevAddons.map(addon => {
        if (addon.manifestUrl === addonManifestUrl) {
          const selectedIds = addon.selectedCatalogIds || [];
          const newSelectedIds = selectedIds.includes(catalogId) 
            ? selectedIds.filter(id => id !== catalogId)
            : [...selectedIds, catalogId];
          return { ...addon, selectedCatalogIds: newSelectedIds };
        }
        return addon;
      })
    );
  }, []);
  
  const getAddonById = useCallback((id: string): InstalledAddon | undefined => {
    return installedAddons.find(addon => addon.id === id);
  }, [installedAddons]);

  const isStreamingAddon = useCallback((addon: InstalledAddon): boolean => {
    if (!addon.resources) return false;
    return addon.resources.some(resource => {
      if (typeof resource === 'string') {
        return resource === 'stream';
      }
      return resource.name === 'stream' && 
             (Array.isArray(resource.types) && (resource.types.includes('movie') || resource.types.includes('series')));
    });
  }, []);

  // Removed TMDB API Key Setter function

  // Method to install a sample addon for demonstration
  const installSampleAddon = useCallback(async () => {
    setError(null);
    try {
      // URL to a sample addon manifest - replace with an actual sample addon
      const sampleManifestUrl = "https://v3-cinemeta.strem.io/manifest.json";
      
      console.log("Installing sample addon (Cinemeta)...");
      await installAddon(sampleManifestUrl);
    } catch (err: any) {
      console.error("Failed to install sample addon:", err);
      setError(`Sample addon installation failed: ${err.message}`);
    }
  }, [installAddon]);

  const value = {
    installedAddons,
    isLoading,
    error,
    installAddon,
    uninstallAddon,
    toggleCatalogSelection,
    getAddonById,
    installSampleAddon,
    isStreamingAddon,
  };

  return <AddonContext.Provider value={value}>{children}</AddonContext.Provider>;
};

// Custom hook for easy consumption
export const useAddonContext = () => {
  const context = useContext(AddonContext);
  if (context === undefined) {
    throw new Error('useAddonContext must be used within an AddonProvider');
  }
  return context;
}; 