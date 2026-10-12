import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Vinext also parses API multipart POSTs through its progressive-action
  // guard. Allow a 20 MiB image plus form overhead; the upload route keeps its
  // own 20 MiB file limit.
  experimental: {
    serverActions: { bodySizeLimit: "21mb" },
  },
};

export default nextConfig;
