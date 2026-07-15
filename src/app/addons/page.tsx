'use client';

import React, { useState, useEffect } from 'react';
import {
  Box, Typography, TextField, Button, List, ListItem, ListItemText,
  CircularProgress, Alert, Paper, IconButton, FormGroup, FormControlLabel, Checkbox, Divider,
  Accordion, AccordionSummary, AccordionDetails, Card, CardContent, CardHeader, Tab, Tabs,
  Switch
} from '@mui/material';
import DeleteIcon from '@mui/icons-material/Delete';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import SettingsIcon from '@mui/icons-material/Settings';
import VpnKeyIcon from '@mui/icons-material/VpnKey';
import { useAddonContext } from '@/context/AddonContext';
import { useTmdbContext } from '@/context/TmdbContext';

// --- Interfaces are now managed by AddonContext ---
// Re-declare AddonCatalog for getCatalogUniqueId if not importing from context or a shared types file
interface AddonCatalog {
  type: string;
  id: string;
  name?: string;
}

export default function AddonsPage() {
  const {
    installedAddons,
    isLoading: isLoadingAddons,
    error: addonContextError,
    installAddon,
    uninstallAddon,
    toggleCatalogSelection,
  } = useAddonContext();

  const {
    tmdbApiKey,
    setTmdbApiKey,
    isLoadingKey: isLoadingTmdbKey,
    keyError: tmdbKeyError,
    isTmdbEnabled,
    toggleTmdbEnabled
  } = useTmdbContext();

  const [addonUrl, setAddonUrl] = useState<string>('');
  const [isLoadingInstall, setIsLoadingInstall] = useState<boolean>(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<number>(0);
  const [inputTmdbKey, setInputTmdbKey] = useState<string>('');
  const [tmdbKeySaveMessage, setTmdbKeySaveMessage] = useState<string | null>(null);

  const getCatalogUniqueId = (catalog: AddonCatalog) => `${catalog.type}/${catalog.id}`;

  useEffect(() => {
    if (addonContextError) setLocalError(addonContextError);
  }, [addonContextError]);

  useEffect(() => {
    if (tmdbKeyError) {
        setTmdbKeySaveMessage(`TMDB Key Error: ${tmdbKeyError}`);
    }
  }, [tmdbKeyError]);

  useEffect(() => {
    if (tmdbApiKey) {
      setInputTmdbKey(tmdbApiKey);
    }
  }, [tmdbApiKey]);

  const handleInstallAddon = async () => {
    setIsLoadingInstall(true);
    setLocalError(null);
    if (!addonUrl) {
        setLocalError("Manifest URL cannot be empty.");
        setIsLoadingInstall(false);
        return;
    }
    try {
      await installAddon(addonUrl);
      setAddonUrl('');
    } catch (err: any) {
      console.error("AddonsPage: Failed to install addon:", err);
      setLocalError(err.message || 'Failed to install addon.');
    } finally {
      setIsLoadingInstall(false);
    }
  };

  const handleUninstallAddon = (manifestUrl: string) => {
    uninstallAddon(manifestUrl);
  };

  const handleToggleCatalog = (addonManifestUrl: string, catalogId: string) => {
    toggleCatalogSelection(addonManifestUrl, catalogId);
  };

  const handleTabChange = (event: React.SyntheticEvent, newValue: number) => {
    setActiveTab(newValue);
  };

  const handleSaveTmdbKey = () => {
    setTmdbKeySaveMessage(null);
    if (!inputTmdbKey.trim()) {
        setTmdbKeySaveMessage("API Key cannot be empty.");
        return;
    }
    try {
        setTmdbApiKey(inputTmdbKey.trim());
        setTmdbKeySaveMessage("TMDB API Key saved successfully!");
        setTimeout(() => setTmdbKeySaveMessage(null), 3000);
    } catch (e: any) {
        console.error("AddonsPage: Failed to save TMDB API Key:", e);
        setTmdbKeySaveMessage(e.message || "Failed to save TMDB API Key.");
    }
  };

  const getCatalogsByType = () => {
    if (!installedAddons) return {};
    
    const catalogsByType: {[key: string]: {catalog: AddonCatalog, addonManifestUrl: string, addonName: string, addonId: string}[]} = {};
    
    installedAddons.forEach(addon => {
      if (addon.catalogs && addon.catalogs.length > 0) {
        addon.catalogs.forEach(catalog => {
          const type = catalog.type;
          if (!catalogsByType[type]) {
            catalogsByType[type] = [];
          }
          catalogsByType[type].push({
            catalog,
            addonManifestUrl: addon.manifestUrl,
            addonName: addon.name,
            addonId: addon.id
          });
        });
      }
    });
    return catalogsByType;
  };

  const catalogsByType = getCatalogsByType();

  if ((isLoadingAddons && !installedAddons.length) || isLoadingTmdbKey) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: 'calc(100vh - 64px)', backgroundColor: '#141414' }}>
        <CircularProgress sx={{ color: 'red' }} />
      </Box>
    );
  }

  return (
    <Box sx={{ pt: 12, px: { xs: 2, md: 7.5 }, pb: 6, minHeight: 'calc(100vh - 64px)', backgroundColor: '#141414' }}>
      {addonContextError && !localError && (
        <Alert severity="error" sx={{ mb: 2, backgroundColor: '#5c0f0f', color: 'white'}}>
            {`Addon Service Error: ${addonContextError}`}
        </Alert>
      )}
      {localError && (
        <Alert severity="error" sx={{ mb: 2, backgroundColor: '#5c0f0f', color: 'white'}} onClose={() => setLocalError(null)}>
            {localError}
        </Alert>
      )}

      <Box sx={{ borderBottom: 1, borderColor: 'divider', mb: 3 }}>
        <Tabs value={activeTab} onChange={handleTabChange} aria-label="Addon manager tabs" sx={{
            "& .MuiTabs-indicator": { backgroundColor: '#e50914' },
            "& .MuiTab-root": { color: 'grey.500', fontWeight: 'bold' },
            "& .Mui-selected": { color: '#e50914' }
        }}>
          <Tab label="Installed Addons" />
          <Tab label="Configure Catalogs" />
        </Tabs>
      </Box>

      {activeTab === 0 && (
        <>
          <Typography variant="h4" component="h1" sx={{ mb: 1, fontWeight: 'bold', color: 'white' }}>
            Manage Addons
          </Typography>
          <Typography variant="body2" sx={{ color: 'grey.400', mb: 3 }}>
            Install official or community Stremio addons by providing their manifest URL.
          </Typography>

          <Paper elevation={2} sx={{ p: {xs: 2, sm: 3}, mb: 4, backgroundColor: '#1f1f1f', borderRadius: '8px' }}>
            <Typography variant="h6" component="h2" sx={{ mb: 2, fontWeight: 'bold', color: 'white' }}>
              Install New Addon
            </Typography>
            <Box component="form" onSubmit={(e) => { e.preventDefault(); handleInstallAddon(); }} sx={{ display: 'flex', gap: {xs: 1, sm: 2}, alignItems: 'flex-start', flexDirection: {xs: 'column', sm: 'row'} }}>
              <TextField
                fullWidth
                label="Addon Manifest URL"
                variant="outlined"
                size="small"
                value={addonUrl}
                onChange={(e) => setAddonUrl(e.target.value)}
                placeholder="https://example.com/stremio-addon/manifest.json"
                sx={{
                  flexGrow: 1,
                  "& .MuiOutlinedInput-root": {
                    "& fieldset": { borderColor: "grey.700" },
                    "&:hover fieldset": { borderColor: "grey.500" },
                    "&.Mui-focused fieldset": { borderColor: "#e50914" },
                    backgroundColor: '#2b2b2b',
                  },
                  "& .MuiInputLabel-root": { color: "grey.400" },
                  "& .MuiInputBase-input": { color: "white" },
                }}
              />
              <Button
                type="submit"
                variant="contained"
                disabled={isLoadingInstall}
                sx={{ 
                    backgroundColor: '#e50914', 
                    color: 'white', 
                    fontWeight: 'bold', 
                    px:3, py:1.25, 
                    minWidth: {xs: '100%', sm: '120px'},
                    '&:hover': { backgroundColor: '#f40612' }
                }}
              >
                {isLoadingInstall ? <CircularProgress size={24} color="inherit" /> : 'Install'}
              </Button>
            </Box>
          </Paper>
          
          <Paper elevation={2} sx={{ p: {xs: 2, sm: 3}, mb: 4, backgroundColor: '#1f1f1f', borderRadius: '8px' }}>
            <Typography variant="h6" component="h2" sx={{ mb: 2, fontWeight: 'bold', color: 'white', display: 'flex', alignItems: 'center' }}>
              <VpnKeyIcon sx={{ mr: 1, color: '#01d277' }} /> TMDB Integration
            </Typography>
            <Typography variant="body2" sx={{ color: 'grey.400', mb: 2 }}>
              Add your TMDB API Key to fetch rich metadata directly from The Movie Database. This can enhance content details and enable other features.
            </Typography>
            <Box component="form" onSubmit={(e) => { e.preventDefault(); handleSaveTmdbKey(); }} sx={{ display: 'flex', gap: {xs: 1, sm: 2}, alignItems: 'flex-start', flexDirection: {xs: 'column', sm: 'row'}, mb: 2 }}>
              <TextField
                fullWidth
                label="TMDB API Key (v3 auth)"
                variant="outlined"
                type="password"
                size="small"
                value={inputTmdbKey}
                onChange={(e) => setInputTmdbKey(e.target.value)}
                placeholder="Enter your TMDB API Key"
                sx={{
                  flexGrow: 1,
                  "& .MuiOutlinedInput-root": {
                    "& fieldset": { borderColor: "grey.700" },
                    "&:hover fieldset": { borderColor: "grey.500" },
                    "&.Mui-focused fieldset": { borderColor: "#01d277" },
                    backgroundColor: '#2b2b2b',
                  },
                  "& .MuiInputLabel-root": { color: "grey.400" },
                  "& .MuiInputBase-input": { color: "white" },
                }}
              />
              <Button
                type="submit"
                variant="contained"
                sx={{ 
                    backgroundColor: '#01d277',
                    color: 'black', 
                    fontWeight: 'bold', 
                    px:3, py:1.25, 
                    minWidth: {xs: '100%', sm: '150px'},
                    '&:hover': { backgroundColor: '#00b368' }
                }}
              >
                Save API Key
              </Button>
            </Box>
            <FormGroup sx={{mt: 1, mb:1}}>
                <FormControlLabel 
                    control={
                        <Switch 
                            checked={isTmdbEnabled}
                            onChange={toggleTmdbEnabled}
                            disabled={!tmdbApiKey || isLoadingTmdbKey}
                            sx={{ 
                                '& .MuiSwitch-switchBase.Mui-checked': {
                                    color: '#01d277',
                                    '&:hover': {
                                        backgroundColor: 'rgba(1, 210, 119, 0.08)',
                                    },
                                },
                                '& .MuiSwitch-switchBase.Mui-checked + .MuiSwitch-track': {
                                    backgroundColor: '#01d277',
                                },
                            }}
                        />
                    }
                    label={`TMDB Integration: ${isTmdbEnabled ? 'Enabled' : 'Disabled'}`}
                    sx={{ color: tmdbApiKey ? 'grey.200' : 'grey.600'}}
                />
            </FormGroup>

            {tmdbKeySaveMessage && (
              <Alert 
                severity={tmdbKeySaveMessage.includes("successfully") ? "success" : tmdbKeySaveMessage.startsWith("TMDB Key Error:") ? "warning" : "error"} 
                sx={{ mt: 2, 
                    backgroundColor: tmdbKeySaveMessage.includes("successfully") ? '#0c4b33' : tmdbKeySaveMessage.startsWith("TMDB Key Error:") ? '#5c4b0f' : '#5c0f0f', 
                    color: 'white'}}>
                {tmdbKeySaveMessage}
              </Alert>
            )}
            {tmdbApiKey && !tmdbKeySaveMessage && !isLoadingTmdbKey && (
                <Typography variant="caption" sx={{ color: 'grey.500', mt:1, display: 'block'}}>
                    API key is configured. Toggle above to enable/disable TMDB features.
                </Typography>
            )}
             {isLoadingTmdbKey && (
                 <Typography variant="caption" sx={{ color: 'grey.500', mt:1, display: 'block'}}>
                    Loading TMDB Key status...
                </Typography>
            )}
          </Paper>
          
          <Typography variant="h5" component="h2" sx={{ mt: 4, mb: 2, fontWeight: 'bold', color: 'white' }}>
            Installed Addons ({installedAddons?.length || 0})
          </Typography>

          {(!installedAddons || installedAddons.length === 0) && !isLoadingAddons && (
            <Alert severity="info" sx={{ backgroundColor: '#1f1f1f', color: 'white' }}>
              No addons installed yet. Paste a manifest URL above to install one.
            </Alert>
          )}

          {installedAddons && installedAddons.length > 0 && (
            <List disablePadding>
              {installedAddons.map((addon) => (
                <Paper key={addon.manifestUrl} elevation={0} sx={{ backgroundColor: '#1f1f1f', mb: 1.5, borderRadius: '4px', p: 2 }}>
                  <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <Box>
                      <Typography variant="h6" component="div" sx={{ color: 'white', fontWeight: 'medium' }}>
                        {addon.name}
                      </Typography>
                      <Typography variant="body2" sx={{ color: 'grey.400', fontSize: '0.8rem' }}>
                        ID: {addon.id} | Version: {addon.version}
                      </Typography>
                      <Typography variant="caption" sx={{ color: 'grey.500', display: 'block', mt: 0.5, wordBreak: 'break-all' }}>
                        {addon.manifestUrl}
                      </Typography>
                    </Box>
                    <IconButton edge="end" aria-label="delete" onClick={() => handleUninstallAddon(addon.manifestUrl)} sx={{color: 'grey.500', '&:hover': {color: '#e50914'}}}>
                      <DeleteIcon />
                    </IconButton>
                  </Box>
                  {addon.description && (
                    <Typography variant="body2" sx={{ color: 'grey.300', mt: 1, fontSize: '0.9rem' }}>
                      {addon.description}
                    </Typography>
                  )}
                  
                  {addon.catalogs && addon.catalogs.length > 0 && (
                    <Accordion 
                      disableGutters 
                      elevation={0} 
                      sx={{ 
                        backgroundColor: 'transparent', 
                        '&:before': { display: 'none' }, 
                        mt: 1 
                      }}
                    >
                      <AccordionSummary
                        expandIcon={<ExpandMoreIcon sx={{ color: 'grey.400' }} />}
                        sx={{ 
                          p: 0, 
                          borderTop: '1px solid #333',
                          minHeight: '40px',
                          '& .MuiAccordionSummary-content': { my: 1 }
                        }}
                      >
                        <Typography variant="subtitle2" sx={{ color: 'grey.300', fontWeight: 'medium' }}>
                          Available Catalogs ({addon.catalogs.length})
                        </Typography>
                      </AccordionSummary>
                      <AccordionDetails sx={{ p: 0, pl: 1, pt: 1 }}>
                        <Typography variant="caption" sx={{ color: 'grey.500', mb: 1, display: 'block' }}>
                          Toggle catalogs to show/hide on homepage and search results
                        </Typography>
                        <FormGroup>
                          {addon.catalogs.map(catalog => {
                            const catalogId = getCatalogUniqueId(catalog);
                            return (
                              <FormControlLabel
                                key={catalogId}
                                control={
                                  <Checkbox
                                    size="small"
                                    checked={addon.selectedCatalogIds?.includes(catalogId) || false}
                                    onChange={() => handleToggleCatalog(addon.manifestUrl, catalogId)}
                                    sx={{ color: 'grey.500', '&.Mui-checked': { color: '#e50914' } }}
                                  />
                                }
                                label={catalog.name || `${catalog.type} - ${catalog.id}`}
                                sx={{ '.MuiFormControlLabel-label': { fontSize: '0.9rem', color: 'grey.200' } }}
                              />
                            );
                          })}
                        </FormGroup>
                      </AccordionDetails>
                    </Accordion>
                  )}
                </Paper>
              ))}
            </List>
          )}
        </>
      )}

      {activeTab === 1 && (
        <>
          <Typography variant="h5" component="h2" sx={{ mb: 3, fontWeight: 'bold', display: 'flex', alignItems: 'center', gap: 1, color: 'white' }}>
            <SettingsIcon sx={{ color: '#e50914' }} />
            Catalog Configuration
          </Typography>

          {(!installedAddons || installedAddons.length === 0) && !isLoadingAddons ? (
            <Alert severity="info" sx={{ backgroundColor: '#1f1f1f', color: 'white' }}>
              No addons installed yet. Install addons first to configure catalogs.
            </Alert>
          ) : Object.keys(catalogsByType).length === 0 && !isLoadingAddons ? (
            <Alert severity="info" sx={{ backgroundColor: '#1f1f1f', color: 'white' }}>
              No catalogs available from installed addons.
            </Alert>
          ) :
            <Box>
              {Object.entries(catalogsByType).map(([type, catalogItems]) => (
                <Card key={type} sx={{ mb: 3, backgroundColor: '#1f1f1f', borderRadius: '8px', overflow: 'visible' }}>
                  <CardHeader 
                    title={type.charAt(0).toUpperCase() + type.slice(1)} 
                    sx={{ 
                      pb: 1,
                      '.MuiCardHeader-title': { 
                        color: 'white', 
                        fontWeight: 'bold',
                        fontSize: '1.1rem'
                      }
                    }}
                  />
                  <Divider sx={{ borderColor: '#333' }} />
                  <CardContent>
                    <Box sx={{ display: 'flex', flexWrap: 'wrap', mx: -0.5 }}>
                      {catalogItems.map(({catalog, addonManifestUrl, addonName, addonId}) => {
                        const catalogId = getCatalogUniqueId(catalog);
                        const catalogDisplayName = catalog.name || catalog.id;
                        const currentAddon = installedAddons.find(ad => ad.manifestUrl === addonManifestUrl);
                        const isEnabled = currentAddon?.selectedCatalogIds?.includes(catalogId) || false;
                        
                        return (
                          <Box 
                            key={`${addonId}-${catalogId}`}
                            sx={{ 
                              width: { xs: '100%', sm: '50%', md: '33.333%' }, 
                              p: 0.5 
                            }}
                          >
                            <Paper 
                              sx={{ 
                                p: 1.5, 
                                backgroundColor: isEnabled ? 'rgba(229, 9, 20, 0.1)' : '#262626', 
                                borderRadius: '4px',
                                border: isEnabled ? '1px solid rgba(229, 9, 20, 0.3)' : '1px solid #333',
                                transition: 'all 0.2s ease',
                                '&:hover': {
                                  backgroundColor: isEnabled ? 'rgba(229, 9, 20, 0.15)' : '#2e2e2e'
                                }
                              }}
                            >
                              <FormControlLabel
                                control={
                                  <Checkbox
                                    size="small"
                                    checked={isEnabled}
                                    onChange={() => handleToggleCatalog(addonManifestUrl, catalogId)}
                                    sx={{ color: 'grey.500', '&.Mui-checked': { color: '#e50914' } }}
                                  />
                                }
                                label={
                                  <Box>
                                    <Typography variant="body2" sx={{ color: 'white', fontWeight: isEnabled ? 'bold' : 'normal' }}>
                                      {catalogDisplayName}
                                    </Typography>
                                    <Typography variant="caption" sx={{ color: 'grey.400', display: 'block' }}>
                                      From: {addonName}
                                    </Typography>
                                  </Box>
                                }
                                sx={{ '.MuiFormControlLabel-label': { fontSize: '0.9rem' } }}
                              />
                            </Paper>
                          </Box>
                        );
                      })}
                    </Box>
                  </CardContent>
                </Card>
              ))}
            </Box>
          }
        </>
      )}
    </Box>
  );
} 