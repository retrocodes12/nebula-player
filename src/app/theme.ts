'use client';
import { Roboto } from 'next/font/google';
import { createTheme } from '@mui/material/styles';

const roboto = Roboto({
  weight: ['300', '400', '500', '700'],
  subsets: ['latin'],
  display: 'swap',
});

const theme = createTheme({
  typography: {
    fontFamily: roboto.style.fontFamily,
  },
  palette: {
    mode: 'dark',
    primary: {
      main: '#e50914', // Netflix red
    },
    background: {
      default: '#141414', // Dark background for body
      paper: '#1c1c1c',   // Slightly lighter dark for paper elements like cards, dialogs
    },
  },
});

export default theme; 