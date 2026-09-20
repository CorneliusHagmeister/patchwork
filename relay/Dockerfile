FROM node:22-alpine

WORKDIR /app

# Install deps first for better layer caching.
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

# Copy the rest of the service.
COPY . .

ENV PORT=8080
EXPOSE 8080

CMD ["node", "server.mjs"]
