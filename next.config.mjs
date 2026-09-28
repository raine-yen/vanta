import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  webpack(config) {
    config.resolve.alias = {
      ...config.resolve.alias,
      "@": resolve(projectRoot, "src"),
    };
    return config;
  },
  experimental: {
    serverActions: { allowedOrigins: ["*"] },
  },
  async headers() {
    return [
      {
        source: "/v2/:path*",
        headers: [
          { key: "Access-Control-Allow-Origin", value: "*" },
          { key: "Access-Control-Allow-Methods", value: "GET, POST, DELETE, OPTIONS" },
          { key: "Access-Control-Allow-Headers", value: "Content-Type, APCA-API-KEY-ID, APCA-API-SECRET-KEY, Authorization" },
        ],
      },
    ];
  },
};

export default nextConfig;
