FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /srv/redblack-core
COPY package.json pnpm-lock.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile --prod && pnpm store prune
COPY backend ./backend
COPY db ./db
COPY frontend ./frontend
USER node
EXPOSE 3000
CMD ["node", "backend/src/server.js"]


