const CACHE_NAME = 'mkass-consistent-logo-v3';
self.addEventListener('install', event => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
