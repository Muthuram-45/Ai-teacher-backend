FROM node:20-slim

# Install ffmpeg (required by upload/transcription pipeline for merging video chunks)
# and build tools for bcrypt native compilation
RUN apt-get update && \
    apt-get install -y --no-install-recommends ffmpeg python3 make g++ && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./

RUN npm ci --omit=dev

COPY . .

ENV NODE_ENV=production
ENV PORT=8080

EXPOSE 8080

CMD ["node", "server.js"]
