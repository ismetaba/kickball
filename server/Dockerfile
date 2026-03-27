FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --production
COPY . .
COPY ../shared/ ./shared/
EXPOSE 8080
CMD ["node", "server.js"]
