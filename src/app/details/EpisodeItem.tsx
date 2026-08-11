'use client';

import React, { useState } from 'react';
import Image from 'next/image';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import PlayArrow from '@mui/icons-material/PlayArrow';

// Reuse the Episode interface (or import if defined elsewhere)
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

interface EpisodeItemProps {
  episode: Episode;
  onClick: (episode: Episode) => void;
}

export default function EpisodeItem({ episode, onClick }: EpisodeItemProps) {
  const [imgError, setImgError] = useState(false);

  const handleImageError = () => {
    setImgError(true);
  };

  // Determine if we should show the image or the placeholder
  const showImage = episode.thumbnail && !imgError;

  return (
    <Box
      onClick={() => onClick(episode)}
      sx={{
        display: 'flex',
        mb: 3,
        py: 2,
        borderRadius: '4px',
        transition: 'background-color 0.2s',
        '&:hover': {
          backgroundColor: 'rgba(255,255,255,0.1)',
          cursor: 'pointer',
          '& .play-icon-container': { // Show play icon on hover of the whole item
            opacity: 1,
          }
        }
      }}
    >
      {/* Episode Number */}
      <Box sx={{
        width: { xs: '40px', md: '60px' },
        flexShrink: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center'
      }}>
        <Typography variant="h4" sx={{
          color: 'grey.500',
          fontWeight: 'bold'
        }}>
          {episode.episode}
        </Typography>
      </Box>

      {/* Thumbnail or Placeholder Area */}
      <Box sx={{
        width: { xs: '120px', sm: '160px', md: '220px' },
        height: { xs: '68px', sm: '90px', md: '124px' },
        flexShrink: 0,
        borderRadius: '4px',
        overflow: 'hidden',
        position: 'relative',
        mr: 2,
        backgroundColor: '#141414', // Base background for placeholder
      }}>
        {showImage ? (
          // Image Container
          <Box sx={{ position: 'relative', width: '100%', height: '100%' }}>
            <Image
              src={episode.thumbnail!}
              alt="" // Alt text is empty for decorative images
              layout="fill"
              objectFit="cover"
              onError={handleImageError}
              // Optional: Add placeholder blur if desired
              // placeholder="blur"
              // blurDataURL="..."
            />
          </Box>
        ) : (
          // Placeholder Container
          <Box sx={{
            width: '100%',
            height: '100%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexDirection: 'column',
            gap: { xs: 0.5, sm: 1 },
            background: 'linear-gradient(45deg, #181818 0%, #2a2a2a 100%)', // Slightly adjusted gradient
            p: { xs: 1, sm: 2 },
            textAlign: 'center'
          }}>
            <Typography variant="body2" sx={{
              color: 'grey.300',
              fontSize: { xs: '0.7rem', sm: '0.8rem' },
              fontWeight: 'medium',
              lineHeight: 1.2
            }}>
              Episode {episode.episode}
            </Typography>
            <Typography variant="caption" sx={{
              color: 'grey.500',
              fontSize: { xs: '0.6rem', sm: '0.7rem' },
              letterSpacing: '0.5px',
              lineHeight: 1.2
            }}>
              {episode.title || 'Preview not available'}
            </Typography>
          </Box>
        )}
        {/* Play Icon Overlay - always present, shown on hover via parent */}
        <Box
          className="play-icon-container"
          sx={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: 'rgba(0,0,0,0.7)',
            opacity: 0,
            transition: 'opacity 0.2s',
            zIndex: 3 // Ensure it's above image/placeholder
          }}
        >
          <PlayArrow sx={{ fontSize: { xs: '2rem', sm: '3rem' } }} />
        </Box>
      </Box>

      {/* Episode Info (Title, Runtime, Overview) */}
      <Box sx={{ flexGrow: 1, pt: { xs: 0.5, sm: 1 } }}>
        <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', mb: 1 }}>
          <Typography variant="body1" component="h3" sx={{ fontWeight: 'bold' }}>
            {episode.title || `Episode ${episode.episode}`}
          </Typography>
          {episode.runtime && (
            <Typography variant="body2" sx={{ color: 'grey.400', flexShrink: 0, ml: 1 }}>
              {episode.runtime}
            </Typography>
          )}
        </Box>
        {episode.overview && (
          <Typography
            variant="body2"
            color="grey.300"
            sx={{
              // Limit overview text lines
              display: '-webkit-box',
              WebkitLineClamp: 2, // Show max 2 lines
              WebkitBoxOrient: 'vertical',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              lineHeight: 1.4
            }}
          >
            {episode.overview}
          </Typography>
        )}
      </Box>
    </Box>
  );
} 