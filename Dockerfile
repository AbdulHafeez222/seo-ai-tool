FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production PLAYWRIGHT_BROWSERS_PATH=/ms-playwright PORT=10000
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npx playwright install --with-deps chromium \
    && groupadd --system scanner && useradd --system --gid scanner scanner \
    && chmod -R a+rX /ms-playwright
COPY --chown=scanner:scanner . .
USER scanner
EXPOSE 10000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/status').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
