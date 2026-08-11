'use client';

import React from 'react';
import StremioVideoPlayer from './StremioVideoPlayer';

interface VideoPlayerProps {
  url: string;
  title?: string;
  quality?: string;
  addonName?: string;
  onClose?: () => void;
  autoPlay?: boolean;
}

// This component maintains the same interface as the original VideoPlayer
// but uses the Stremio-based implementation
export default function StremioPlayer(props: VideoPlayerProps) {
  return <StremioVideoPlayer {...props} />;
} 