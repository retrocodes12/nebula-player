'use client';

import React from 'react';
import VideoPlayer from './VideoPlayer';
import StremioPlayer from './StremioPlayer';
import ShakaPlayer from './ShakaPlayer';
import { hasClearKey } from '@/lib/clearkey';

interface VideoPlayerWrapperProps {
  url: string;
  title?: string;
  quality?: string;
  addonName?: string;
  onClose?: () => void;
  autoPlay?: boolean;
  useStremio?: boolean; // Flag to choose which player to use
}

export default function VideoPlayerWrapper({
  useStremio = true, // Default to using Stremio player
  ...props
}: VideoPlayerWrapperProps) {
  // ClearKey streams (URL carries a #clearkey=<kid>:<key> fragment) need EME
  // decryption, which neither the Stremio nor react-player path supports. Route
  // those to the Shaka-based player instead.
  if (hasClearKey(props.url)) {
    return <ShakaPlayer {...props} />;
  }

  // Use the Stremio player or fall back to the original player
  return useStremio ? <StremioPlayer {...props} /> : <VideoPlayer {...props} />;
} 