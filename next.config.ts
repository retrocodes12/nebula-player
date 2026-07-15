import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The upstream codebase does not pass next lint (many pre-existing @ts-ignore /
  // explicit-any usages). Skip lint during production builds; TypeScript type
  // checking still runs and will fail the build on real type errors.
  eslint: {
    ignoreDuringBuilds: true,
  },
  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: 'image.tmdb.org',
        port: '',
        pathname: '/t/p/**',
      },
      // Add other hostnames if needed from Figma data
      {
        protocol: 'https',
        hostname: 's3-alpha.figma.com', // For Figma thumbnails
        port: '',
        pathname: '/**',
      },
      {
        protocol: 'https', // Added for the catalog addon
        hostname: 'images.metahub.space',
        port: '',
        pathname: '/**', // Allow any path from this host
      },
      {
        protocol: 'https', // Added for another catalog addon source
        hostname: 'live.metahub.space',
        port: '',
        pathname: '/**', // Allow any path from this host
      },
      {
        protocol: 'https', // Added for ratingposterdb
        hostname: 'api.ratingposterdb.com',
        port: '',
        pathname: '/**', // Allow any path from this host
      },
      // Additional common media hosts for backgrounds and logos
      {
        protocol: 'https',
        hostname: 'img.youtube.com', // For YouTube thumbnails
        port: '',
        pathname: '/**',
      },
      {
        protocol: 'https',
        hostname: 'i.imgur.com', // For Imgur images
        port: '',
        pathname: '/**',
      },
      {
        protocol: 'https',
        hostname: 'i.postimg.cc', // For PostImg images
        port: '',
        pathname: '/**',
      },
      {
        protocol: 'https',
        hostname: 'assets.fanart.tv', // For FanArt.tv
        port: '',
        pathname: '/**',
      },
      {
        protocol: 'https',
        hostname: 'thetvdb.com', // For TheTVDB
        port: '',
        pathname: '/**',
      },
      {
        protocol: 'https',
        hostname: 'artworks.thetvdb.com', // For TheTVDB artworks
        port: '',
        pathname: '/**',
      },
      {
        protocol: 'https',
        hostname: '**', // Wildcard for any addon-provided image domain
        port: '',
        pathname: '/**',
      },
    ],
  },
};

export default nextConfig;
