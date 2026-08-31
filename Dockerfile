# Local development image for Criba.
#
# Production runs on Vercel as a serverless function; this image exists only so
# the whole app — Node server + Redis (see docker-compose.yml) — runs locally
# with one command and no external services. It is NOT the Vercel build.
FROM node:20-alpine

WORKDIR /app

# Install dependencies first so a source-only change doesn't reinstall everything.
# Copies package-lock.json too when present (the glob tolerates its absence).
COPY package*.json ./
RUN npm install

# Fallback copy of the source. In dev, docker-compose bind-mounts the working
# tree over this, so live edits win; the copy is what makes `docker build` alone
# produce a runnable image.
COPY . .

EXPOSE 3000

# `npm run dev` is `node --watch api/server.js` — restarts on file changes.
CMD ["npm", "run", "dev"]
