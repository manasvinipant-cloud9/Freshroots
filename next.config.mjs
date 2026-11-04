/** @type {import('next').NextConfig} */
const nextConfig = {
  // The seed CSVs are read from disk at run time, so make sure they ship with the serverless functions.
  outputFileTracingIncludes: { "/api/**": ["./data/**", "./config/**"], "/**": ["./data/**", "./config/**"] },
};
export default nextConfig;
