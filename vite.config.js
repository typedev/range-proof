import { defineConfig } from 'vite'

export default defineConfig({
  // Relative asset paths so the built app works from any static subdirectory.
  base: './',
  build: {
    // The Unicode character-name table is a 1.4 MB chunk on purpose: it is
    // loaded only when a reader opens "Everything in the font".
    chunkSizeWarningLimit: 1600,
  },
})
