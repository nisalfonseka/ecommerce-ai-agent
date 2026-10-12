import type { NextConfig } from "next";

const config: NextConfig = {
  // Product images are plain <img> tags from the store's own /images; nothing to optimise in the reference store.
  images: { unoptimized: true },
};

export default config;
