'use client';

import React, { createContext, useState, useEffect, useContext, ReactNode, useCallback } from 'react';

// Interface for the TMDB Context
interface TmdbContextType {
  tmdbApiKey: string | null;
  setTmdbApiKey: (key: string | null) => void;
  isLoadingKey: boolean;
  keyError: string | null;
  isTmdbEnabled: boolean;
  toggleTmdbEnabled: () => void;
}

// Create the context
const TmdbContext = createContext<TmdbContextType | undefined>(undefined);

// Define keys for local storage
const TMDB_STORAGE_PREFIX = 'tmdbConfig';
const TMDB_API_KEY_STORAGE_KEY = `${TMDB_STORAGE_PREFIX}_apiKey`;
const TMDB_ENABLED_STATUS_KEY = `${TMDB_STORAGE_PREFIX}_isEnabled`;

// Provider component
export const TmdbProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [tmdbApiKey, setTmdbApiKeyInternal] = useState<string | null>(null);
  const [isTmdbEnabled, setIsTmdbEnabledInternal] = useState<boolean>(true);
  const [isLoadingKey, setIsLoadingKey] = useState<boolean>(true);
  const [keyError, setKeyError] = useState<string | null>(null);

  // Load TMDB config from local storage on mount
  useEffect(() => {
    setIsLoadingKey(true);
    try {
      const storedKey = localStorage.getItem(TMDB_API_KEY_STORAGE_KEY);
      if (storedKey) {
        setTmdbApiKeyInternal(storedKey);
      }
      const storedEnabledStatus = localStorage.getItem(TMDB_ENABLED_STATUS_KEY);
      setIsTmdbEnabledInternal(storedEnabledStatus === null ? true : JSON.parse(storedEnabledStatus));
      
      setKeyError(null);
    } catch (e) {
      console.error("TmdbContext: Error loading TMDB config:", e);
      setKeyError('Error loading TMDB config from storage.');
      setTmdbApiKeyInternal(null);
      setIsTmdbEnabledInternal(true);
    } finally {
      setIsLoadingKey(false);
    }
  }, []);

  // Save TMDB API key to local storage whenever it changes
  useEffect(() => {
    if (!isLoadingKey) { 
      try {
        if (tmdbApiKey) {
          localStorage.setItem(TMDB_API_KEY_STORAGE_KEY, tmdbApiKey);
        } else {
          localStorage.removeItem(TMDB_API_KEY_STORAGE_KEY);
        }
      } catch (e) {
        console.error("TmdbContext: Error saving TMDB API key:", e);
        setKeyError('Error saving TMDB API key.');
      }
    }
  }, [tmdbApiKey, isLoadingKey]);

  // Save TMDB enabled status to local storage whenever it changes
  useEffect(() => {
    if (!isLoadingKey) {
        try {
            localStorage.setItem(TMDB_ENABLED_STATUS_KEY, JSON.stringify(isTmdbEnabled));
        } catch (e) {
            console.error("TmdbContext: Error saving TMDB enabled status:", e);
            setKeyError("Error saving TMDB enabled status.");
        }
    }
  }, [isTmdbEnabled, isLoadingKey]);

  // Public setter for the API key
  const setTmdbApiKey = useCallback((key: string | null) => {
    setTmdbApiKeyInternal(key);
  }, []);

  // Public toggle for enabled status
  const toggleTmdbEnabled = useCallback(() => {
    setIsTmdbEnabledInternal(prev => !prev);
  }, []);

  const value = {
    tmdbApiKey,
    setTmdbApiKey,
    isLoadingKey,
    keyError,
    isTmdbEnabled,
    toggleTmdbEnabled
  };

  return <TmdbContext.Provider value={value}>{children}</TmdbContext.Provider>;
};

// Custom hook for easy consumption
export const useTmdbContext = () => {
  const context = useContext(TmdbContext);
  if (context === undefined) {
    throw new Error('useTmdbContext must be used within a TmdbProvider');
  }
  return context;
}; 