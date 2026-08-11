'use client';

import React, { useState, useRef, useEffect } from 'react';
import AppBar from '@mui/material/AppBar';
import Toolbar from '@mui/material/Toolbar';
import Box from '@mui/material/Box';
import Link from '@mui/material/Link';
import IconButton from '@mui/material/IconButton';
import Avatar from '@mui/material/Avatar';
import SearchIcon from '@mui/icons-material/Search';
import NotificationsIcon from '@mui/icons-material/Notifications';
import CloseIcon from '@mui/icons-material/Close';
import InputBase from '@mui/material/InputBase';
import { useRouter } from 'next/navigation';
import Image from 'next/image'; // Use next/image for logo
import NextLink from 'next/link'; // Import NextLink for client-side navigation

const navLinks = [
  { name: 'Home', href: '/' }, // Point Home to root
  { name: 'TV Shows', href: '#' },
  { name: 'Movies', href: '#' },
  { name: 'New & Popular', href: '#' },
  { name: 'My List', href: '#' },
  { name: 'Browse by Languages', href: '#' },
  { name: 'Addons', href: '/addons' }, // Added Addons link
];

// TODO: Add profile image from Figma node 5:408 if needed
const profileImageUrl = '/assets/icons/default-profile.png'; // Placeholder

const Header: React.FC = () => {
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const searchInputRef = useRef<HTMLInputElement>(null);
  const router = useRouter();
  
  // Focus the search input when opened
  useEffect(() => {
    if (searchOpen && searchInputRef.current) {
      searchInputRef.current.focus();
    }
  }, [searchOpen]);

  const handleSearchToggle = () => {
    setSearchOpen(prevState => !prevState);
    if (searchOpen) {
      setSearchQuery(''); // Clear search when closing
    }
  };

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (searchQuery.trim()) {
      router.push(`/search?q=${encodeURIComponent(searchQuery.trim())}`);
      setSearchOpen(false);
    }
  };

  return (
    <AppBar position="fixed" sx={{ background: 'transparent', backgroundImage: 'linear-gradient(to bottom, rgba(0,0,0,0.7) 10%, rgba(0,0,0,0))', boxShadow: 'none' }}>
      <Toolbar sx={{ justifyContent: 'space-between', px: { xs: 2, md: 7.5 } /* Corresponds to 60px padding */ }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          {/* Netflix Logo */}
          <Link href="#" sx={{ lineHeight: 0 /* Prevents layout shift */ }}>
            <Image
              src="/assets/icons/netflix-logo.svg"
              alt="Netflix Logo"
              width={92} // Adjust size as needed based on original SVG
              height={25} // Adjust size as needed
              priority
            />
          </Link>
          {/* Navigation Links - Hide when search is open on smaller screens */}
          <Box sx={{ 
            display: { 
              xs: searchOpen ? 'none' : 'none', 
              md: searchOpen ? 'none' : 'flex' 
            }, 
            gap: 2.5 /* Approx 20px */ 
          }}>
            {navLinks.map((link) => (
              <Link
                key={link.name}
                component={NextLink} // Use NextLink for routing
                href={link.href}
                color="#e5e5e5" // Light gray, adjust based on Figma
                underline="none"
                sx={{ fontSize: '14px', fontWeight: 'normal', transition: 'color 0.3s', '&:hover': { color: '#b3b3b3' /* Slightly darker gray */ } }}
              >
                {link.name}
              </Link>
            ))}
          </Box>
        </Box>

        <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
          {/* Search Bar - Show when search is open */}
          {searchOpen && (
            <Box 
              component="form" 
              onSubmit={handleSearchSubmit}
              sx={{ 
                display: 'flex', 
                alignItems: 'center',
                backgroundColor: '#141414',
                border: '1px solid #333',
                borderRadius: '4px',
                padding: '2px 8px',
                transition: 'all 0.3s ease',
                width: { xs: '200px', sm: '300px' }
              }}
            >
              <SearchIcon sx={{ color: 'white', mr: 1 }} />
              <InputBase
                placeholder="Titles, people, genres..."
                inputRef={searchInputRef}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                sx={{ 
                  color: 'white', 
                  flex: 1,
                  '& input': {
                    padding: '8px 0',
                    fontSize: '14px'
                  }
                }}
              />
              <IconButton 
                size="small" 
                onClick={handleSearchToggle}
                sx={{ color: 'white', padding: '4px' }}
              >
                <CloseIcon fontSize="small" />
              </IconButton>
            </Box>
          )}
          
          {/* Search Icon - Hide when search is open */}
          {!searchOpen && (
            <IconButton color="inherit" onClick={handleSearchToggle}>
              <SearchIcon />
            </IconButton>
          )}
          
          <IconButton color="inherit">
            <NotificationsIcon />
          </IconButton>
          {/* Profile Avatar/Dropdown */}
          <IconButton sx={{ p: 0 }}>
            <Avatar alt="Profile" src={profileImageUrl} sx={{ width: 32, height: 32, borderRadius: '4px' /* From Figma */ }} />
            <img src="/assets/icons/dropdown-arrow-icon.svg" alt="Dropdown" style={{ marginLeft: '6px' }} />
          </IconButton>
        </Box>
      </Toolbar>
    </AppBar>
  );
};

export default Header;
 